//! Public YouTube thumbnails only. No room URL, session client or browser IPC is accepted.
use image::{ImageFormat, ImageReader, Limits, RgbaImage};
use std::{
    collections::VecDeque,
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{runtime::Handle, sync::oneshot, task::AbortHandle};

const MAX_BYTES: usize = 512 * 1024;
const CACHE_ENTRIES: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YoutubeId(String);
impl YoutubeId {
    pub fn parse(id: &str) -> Option<Self> {
        (id.len() == 11
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))
        .then(|| Self(id.into()))
    }
    pub fn thumbnail_url(&self) -> String {
        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", self.0)
    }
}

pub fn decode(bytes: &[u8]) -> Option<RgbaImage> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    if !matches!(reader.format(), Some(ImageFormat::Jpeg | ImageFormat::Png)) {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(1024);
    limits.max_image_height = Some(1024);
    limits.max_alloc = Some(8 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    Some(
        if image.width() > 480 || image.height() > 480 {
            image.thumbnail(480, 480)
        } else {
            image
        }
        .to_rgba8(),
    )
}

type Cache = VecDeque<(YoutubeId, Option<Arc<RgbaImage>>)>;
pub struct Loader {
    client: reqwest::Client,
    runtime: Handle,
    cache: Arc<Mutex<Cache>>,
}
pub struct Request {
    pub result: oneshot::Receiver<Option<Arc<RgbaImage>>>,
    abort: AbortHandle,
}
impl Drop for Request {
    fn drop(&mut self) {
        self.abort.abort();
    }
}
impl Loader {
    pub fn new(runtime: Handle) -> reqwest::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .build()?,
            runtime,
            cache: Arc::new(Mutex::new(VecDeque::new())),
        })
    }
    /// One caller-held request; replacing/dropping it aborts in-flight HTTP. Cache includes misses.
    pub fn load(&self, id: YoutubeId) -> Request {
        let client = self.client.clone();
        let cache = self.cache.clone();
        let (send, result) = oneshot::channel();
        let task = self.runtime.spawn(async move {
            let cached = cache
                .lock()
                .unwrap()
                .iter()
                .find(|(key, _)| key == &id)
                .cloned();
            let image = if let Some((_, image)) = cached {
                image
            } else {
                let image = fetch(&client, &id).await.map(Arc::new);
                let mut cache = cache.lock().unwrap();
                if cache.len() == CACHE_ENTRIES {
                    cache.pop_front();
                }
                cache.push_back((id, image.clone()));
                image
            };
            let _ = send.send(image);
        });
        Request {
            result,
            abort: task.abort_handle(),
        }
    }
}

async fn fetch(client: &reqwest::Client, id: &YoutubeId) -> Option<RgbaImage> {
    read_response(client.get(id.thumbnail_url()).send().await.ok()?).await
}

async fn read_response(mut response: reqwest::Response) -> Option<RgbaImage> {
    if !response.status().is_success() {
        return None;
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    // Strict dimensions bound CPU and memory; only one small still frame, no animation or SVG.
    decode(&bytes)
}

/// Local monotonic request identity fences A -> B -> A and room/account/socket replacement.
#[derive(Default)]
pub struct Selection {
    serial: u64,
    current: Option<YoutubeId>,
}
impl Selection {
    pub fn replace(&mut self, id: Option<YoutubeId>) -> u64 {
        self.serial = self.serial.wrapping_add(1);
        self.current = id;
        self.serial
    }
    pub fn accepts(&self, serial: u64) -> bool {
        self.current.is_some() && self.serial == serial
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn png() -> Vec<u8> {
        let mut data = Cursor::new(Vec::new());
        RgbaImage::from_pixel(2, 3, image::Rgba([1, 2, 3, 255]))
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        data.into_inner()
    }

    async fn fixture(response: Vec<u8>) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let _ = stream.write_all(&response).await;
        });
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
            .get(format!("http://{address}/fixture"))
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn response_bounds_cover_declared_size_chunked_overflow_and_redirects() {
        let data = png();
        let mut valid = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            data.len()
        )
        .into_bytes();
        valid.extend_from_slice(&data);
        assert_eq!(
            read_response(fixture(valid).await)
                .await
                .unwrap()
                .dimensions(),
            (2, 3)
        );

        let oversized = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_BYTES + 1
        )
        .into_bytes();
        assert!(read_response(fixture(oversized).await).await.is_none());
        let mut chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n",
            MAX_BYTES + 1
        )
        .into_bytes();
        chunked.extend(vec![0; MAX_BYTES + 1]);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        assert!(read_response(fixture(chunked).await).await.is_none());

        let mut redirect = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",data.len()).into_bytes();
        redirect.extend_from_slice(&data);
        assert!(read_response(fixture(redirect).await).await.is_none());
    }

    #[tokio::test]
    async fn cached_images_and_misses_do_not_need_network_and_dropping_request_aborts() {
        let loader = Loader::new(Handle::current()).unwrap();
        let id = YoutubeId::parse("abcdefghijk").unwrap();
        let image = Arc::new(decode(&png()).unwrap());
        loader
            .cache
            .lock()
            .unwrap()
            .push_back((id.clone(), Some(image.clone())));
        let mut request = loader.load(id.clone());
        assert!(Arc::ptr_eq(
            &(&mut request.result).await.unwrap().unwrap(),
            &image
        ));
        loader.cache.lock().unwrap().clear();
        loader.cache.lock().unwrap().push_back((id.clone(), None));
        let mut request = loader.load(id);
        assert!((&mut request.result).await.unwrap().is_none());
        let task = tokio::spawn(std::future::pending::<()>());
        let (_, result) = oneshot::channel();
        drop(Request {
            result,
            abort: task.abort_handle(),
        });
        assert!(task.await.unwrap_err().is_cancelled());
    }
    #[test]
    fn only_exact_video_ids_can_make_public_https_urls() {
        assert_eq!(
            YoutubeId::parse("aB01_-xyz89").unwrap().thumbnail_url(),
            "https://i.ytimg.com/vi/aB01_-xyz89/hqdefault.jpg"
        );
        for id in [
            "",
            "abcdefghij",
            "abcdefghijk/",
            "../secret01",
            "https://x.y",
            "abc?token=x",
            "localhost:1",
            "ébcdefghij",
        ] {
            assert!(YoutubeId::parse(id).is_none(), "{id}");
        }
    }
    #[test]
    fn decode_rejects_invalid_oversized_and_non_raster_input() {
        assert!(decode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_none());
        assert!(decode(&vec![0; MAX_BYTES + 1]).is_none());
        let mut data = Cursor::new(Vec::new());
        RgbaImage::from_pixel(2, 3, image::Rgba([1, 2, 3, 255]))
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        assert_eq!(decode(data.get_ref()).unwrap().dimensions(), (2, 3));
        let mut data = Cursor::new(Vec::new());
        RgbaImage::new(1025, 1)
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        assert!(decode(data.get_ref()).is_none());
        let mut jpeg = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(640, 480, image::Rgb([40, 80, 120]))
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let decoded = decode(jpeg.get_ref()).unwrap();
        assert_eq!(decoded.dimensions(), (480, 360));
        assert_eq!(decoded.get_pixel(0, 0)[3], 255);
    }
    #[test]
    fn old_track_and_identity_completions_cannot_restore_art() {
        let mut selection = Selection::default();
        let a = YoutubeId::parse("abcdefghijk");
        let first = selection.replace(a.clone());
        selection.replace(YoutubeId::parse("12345678901"));
        let last = selection.replace(a);
        assert!(!selection.accepts(first));
        assert!(selection.accepts(last));
        selection.replace(None); // clear, disconnect or account/socket fence
        assert!(!selection.accepts(last));
    }
}
