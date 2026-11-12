//! The room's past, present and future, shared by every queue view: played tracks (oldest
//! first, each one a click away), the current track as a "now playing" card, then what comes
//! next. Rows show validated room data only; covers come from the bounded public thumbnail
//! loader, never from a URL the room supplied.
use super::{
    Player,
    ui::{self, rgb},
    ui_music::provider_name,
};
use crate::theme;
use gpui::{
    Bounds, ContentMask, Context, Div, FontWeight, Hsla, IntoElement, Pixels, Stateful, Task,
    Window, canvas, div, fill, point, prelude::*, px, size,
};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    rc::Rc,
    sync::{Arc, LazyLock},
    time::Instant,
};
use undertone_desktop::{
    artwork::YoutubeId,
    music::{self, Entry, RoomMusic, RoomState, RoomTrack},
    text,
};

/// One row of a queue view.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueueTrack {
    pub title: Option<String>,
    /// Artists and who brought it (Music rooms), or the provider (regular queues).
    pub detail: Option<String>,
    pub cover: Option<YoutubeId>,
}

/// What every queue view shows, rebuilt from each room state.
#[derive(Debug, Default)]
pub struct QueueView {
    /// Every played track the server published, oldest first; an index maps to `steps`.
    pub played: Vec<QueueTrack>,
    pub current: Option<QueueTrack>,
    pub upcoming: Vec<QueueTrack>,
}
/// A Music room entry: its artists and who brought it, and its public cover.
pub fn entry_track(music: &RoomMusic, entry: &Entry) -> QueueTrack {
    let contributor = music
        .participants
        .iter()
        .find(|p| p.participant_id == entry.contributor_id)
        .and_then(|p| p.name.clone());
    QueueTrack {
        title: entry.title.clone(),
        detail: join([
            (!entry.artists.is_empty()).then(|| entry.artists.join(", ")),
            contributor,
        ]),
        cover: entry
            .artwork_url
            .as_deref()
            .and_then(YoutubeId::from_artwork_url),
    }
}

impl QueueView {
    pub fn from_room(room: &RoomState) -> Self {
        if room.music_mode() {
            let Some(music) = room.music.as_ref() else {
                return Self::default();
            };
            let entry = |entry: &Entry| entry_track(music, entry);
            Self {
                played: music.played.iter().map(entry).collect(),
                current: music.current.as_ref().map(|current| entry(&current.entry)),
                upcoming: music.queue.iter().map(entry).collect(),
            }
        } else {
            let track = |track: &RoomTrack| QueueTrack {
                title: track.title.clone(),
                detail: track.service.map(provider_name),
                cover: track.youtube.clone(),
            };
            Self {
                played: room.played_tracks.iter().map(track).collect(),
                current: room.current_track.as_ref().map(track),
                upcoming: room.upcoming.iter().map(track).collect(),
            }
        }
    }
    /// Whether there is anything before the upcoming tracks.
    pub fn history(&self) -> bool {
        !self.played.is_empty() || self.current.is_some()
    }
    /// The last `max` played tracks, each with its index in [`Self::played`].
    pub fn recent(&self, max: usize) -> impl Iterator<Item = (usize, &QueueTrack)> {
        self.played
            .iter()
            .enumerate()
            .skip(self.played.len().saturating_sub(max))
    }
    /// The `previous` steps that return to `played[index]`.
    pub fn steps(&self, index: usize) -> Option<u8> {
        music::steps_back(self.played.len(), index)
    }
    fn covers(&self) -> impl Iterator<Item = &YoutubeId> {
        self.played
            .iter()
            .chain(&self.current)
            .chain(&self.upcoming)
            .filter_map(|track| track.cover.as_ref())
    }
}

fn join<const N: usize>(parts: [Option<String>; N]) -> Option<String> {
    let parts: Vec<String> = parts
        .into_iter()
        .flatten()
        .filter(|part| !part.trim().is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Covers fetched at once; the rest wait their turn.
const COVER_CONCURRENCY: usize = 3;
/// Row covers of the tracks on show (at most the published history, the current track, the
/// public queue and one queue page), as small decoded thumbnails.
#[derive(Default)]
pub struct Covers {
    images: HashMap<String, Option<Arc<gpui::RenderImage>>>,
    queue: VecDeque<YoutubeId>,
    inflight: HashMap<String, Task<()>>,
}
impl Covers {
    pub fn get(&self, id: Option<&YoutubeId>) -> Option<Arc<gpui::RenderImage>> {
        self.images.get(id?.as_str()).cloned().flatten()
    }
}

impl Player {
    /// Keeps the covers of the tracks on show: forgets the others (dropping a fetch aborts
    /// its HTTP) and fetches the missing ones, a few at a time.
    pub(super) fn sync_covers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let page = &self.native.room.queue_page;
        let items = if self.native.room.music_mode() && page.loaded && !page.stale {
            page.items.as_slice()
        } else {
            &[]
        };
        let paged = items.iter().filter_map(|entry| {
            entry
                .artwork_url
                .as_deref()
                .and_then(YoutubeId::from_artwork_url)
        });
        let mut wanted: Vec<YoutubeId> = Vec::new();
        for id in self.queue.covers().cloned().chain(paged) {
            if !wanted.contains(&id) {
                wanted.push(id);
            }
        }
        let shown = |key: &str| wanted.iter().any(|id| id.as_str() == key);
        let covers = &mut self.covers;
        covers.images.retain(|key, _| shown(key));
        covers.inflight.retain(|key, _| shown(key));
        covers.queue.retain(|id| shown(id.as_str()));
        for id in wanted {
            let key = id.as_str();
            if !covers.images.contains_key(key)
                && !covers.inflight.contains_key(key)
                && !covers.queue.contains(&id)
            {
                covers.queue.push_back(id);
            }
        }
        self.pump_covers(window, cx);
    }
    fn pump_covers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        while self.covers.inflight.len() < COVER_CONCURRENCY
            && let Some(id) = self.covers.queue.pop_front()
        {
            let key = id.as_str().to_owned();
            let mut request = self.artwork_loader.load(id);
            let done = key.clone();
            let task = cx.spawn_in(window, async move |this, cx| {
                let art = (&mut request.result).await.ok().flatten();
                let _ = this.update_in(cx, |player, window, cx| {
                    // Gone from the view (or the room) meanwhile: the result is not wanted.
                    let Some(task) = player.covers.inflight.remove(&done) else {
                        return;
                    };
                    task.detach();
                    player.covers.images.insert(
                        done,
                        art.map(|art| {
                            Arc::new(gpui::RenderImage::new(vec![image::Frame::new(
                                art.thumb_bgra.clone(),
                            )]))
                        }),
                    );
                    player.pump_covers(window, cx);
                    cx.notify();
                });
            });
            self.covers.inflight.insert(key, task);
        }
    }
}

const BAR_WIDTH: f32 = 3.;
const BAR_GAP: f32 = 2.;
const BAR_HEIGHT: f32 = 12.;
/// One breath of a bar, in seconds (rise then fall).
const BAR_BREATH: f32 = 1.1;
static BARS_EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Heights of the three now-playing bars (fractions of their box) `seconds` into the
/// animation: each rises and falls with an ease-in-out, a little behind the previous one.
pub fn bar_levels(seconds: f32) -> [f32; 3] {
    [0., 0.4, 0.8].map(|delay| {
        let phase = ((seconds + delay) / BAR_BREATH).rem_euclid(2.);
        let rise = if phase < 1. { phase } else { 2. - phase };
        0.3 + 0.7 * (0.5 - 0.5 * (std::f32::consts::PI * rise).cos())
    })
}

/// The now-playing bars of one window. Its cached body records where each set sits when it
/// is laid out; an overlay above the body paints them. The overlay is part of the window's
/// root, which redraws on every frame of the window's sky: about 30 per second while the
/// window is visible with animations on, none while it is hidden. The body is never rebuilt
/// for the bars and no timer of their own exists.
#[derive(Clone, Default)]
pub struct Bars(Rc<RefCell<Vec<Spot>>>);
/// Where one set of bars sits, and the visible area around it (scrolled panels clip it).
type Spot = (Bounds<Pixels>, Bounds<Pixels>);
impl Bars {
    /// Called when the body is rebuilt, before its bars are laid out again.
    pub fn clear(&self) {
        self.0.borrow_mut().clear();
    }
    /// Room for one set of bars in the body.
    fn slot(&self) -> impl IntoElement {
        let spots = self.0.clone();
        canvas(
            move |bounds, window, _| {
                spots
                    .borrow_mut()
                    .push((bounds, window.content_mask().bounds));
            },
            |_, _, _, _| {},
        )
        .w(px(3. * BAR_WIDTH + 2. * BAR_GAP))
        .h(px(BAR_HEIGHT))
        .flex_shrink_0()
    }
    /// The bars over the body: breathing while `moving` (the room plays and animations are
    /// on), resting otherwise.
    pub fn overlay(&self, moving: bool, color: Hsla) -> impl IntoElement {
        let spots = self.0.clone();
        let levels = bar_levels(if moving {
            BARS_EPOCH.elapsed().as_secs_f32()
        } else {
            0.
        });
        canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                for (slot, mask) in spots.borrow().iter() {
                    window.with_content_mask(Some(ContentMask { bounds: *mask }), |window| {
                        for (index, level) in levels.iter().enumerate() {
                            let height = BAR_HEIGHT * level;
                            let bar = Bounds::new(
                                point(
                                    slot.origin.x + px(index as f32 * (BAR_WIDTH + BAR_GAP)),
                                    slot.origin.y + px(BAR_HEIGHT - height),
                                ),
                                size(px(BAR_WIDTH), px(height)),
                            );
                            window.paint_quad(fill(bar, color).corner_radii(px(1.5)));
                        }
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

/// A queue cover: the track's thumbnail, or the ambience's logo.
fn thumb(edge: f32, image: Option<Arc<gpui::RenderImage>>) -> Div {
    ui::artwork(edge, image).rounded(px((edge * 0.22).min(12.)))
}

fn title_line(title: String, size: f32) -> Div {
    div()
        .text_size(px(size))
        .font_weight(FontWeight::MEDIUM)
        .truncate()
        .child(title)
}

fn untitled(track: &QueueTrack) -> String {
    track.title.clone().unwrap_or_else(|| text("untitledTrack"))
}

/// Layout of a played row on an interactive base that has no hover or tooltip yet (GPUI
/// allows one of each per element). Quiet, like the past; a replay mark shows on hover.
pub fn played_row(
    base: Stateful<Div>,
    track: &QueueTrack,
    image: Option<Arc<gpui::RenderImage>>,
    edge: f32,
    detail: bool,
    enabled: bool,
) -> Stateful<Div> {
    let tip = text(if enabled {
        "playAgainHint"
    } else {
        "playAgainUnavailable"
    });
    base.group("played-row")
        .w_full()
        .flex()
        .items_center()
        .justify_start()
        .gap(px(10.))
        .px(px(6.))
        .py(px(3.))
        .rounded(px(10.))
        .text_color(rgb(ui::MUTED))
        .opacity(0.8)
        .when(enabled, |s| {
            s.hover(|s| {
                s.bg(rgb(ui::SECONDARY))
                    .text_color(rgb(ui::TEXT))
                    .opacity(1.)
            })
        })
        .tooltip(move |_, cx| cx.new(|_| ui::Tip(tip.clone())).into())
        .child(thumb(edge, image))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .flex_1()
                .child(title_line(untitled(track), 13.))
                .when_some(track.detail.clone().filter(|_| detail), |s, detail| {
                    s.child(ui::quiet(detail, 11.5))
                }),
        )
        .child(
            div()
                .flex_shrink_0()
                .invisible()
                .when(enabled, |s| s.group_hover("played-row", |s| s.visible()))
                .child(ui::icon("replay", 15.).text_color(rgb(ui::TEXT))),
        )
}

/// The current track: a soft accent wash, a real cover, an italic "Now playing" (or
/// "Paused") after three bars, and the title in the display face (one line when `compact`).
pub fn now_card(
    track: &QueueTrack,
    fallback_title: &str,
    image: Option<Arc<gpui::RenderImage>>,
    playing: bool,
    bars: &Bars,
    edge: f32,
    compact: bool,
) -> Div {
    let accent = rgb(ui::AMBER);
    let title = track
        .title
        .clone()
        .or_else(|| (!fallback_title.is_empty()).then(|| fallback_title.to_owned()))
        .unwrap_or_else(|| text("untitledTrack"));
    div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(12.))
        .my(px(if compact { 2. } else { 4. }))
        .p(px(if compact { 6. } else { 8. }))
        .pr(px(12.))
        .rounded(px(14.))
        .bg(gpui::linear_gradient(
            100.,
            gpui::linear_color_stop(accent.opacity(0.17), 0.),
            gpui::linear_color_stop(accent.opacity(0.), 1.),
        ))
        .border_1()
        .border_color(accent.opacity(0.22))
        .child(thumb(edge, image))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .min_w_0()
                .flex_1()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .text_color(accent)
                        .font_family(theme::voice())
                        .italic()
                        .text_size(px(14.))
                        .child(bars.slot())
                        .child(text(if playing {
                            "nowPlayingTrack"
                        } else {
                            "nowPaused"
                        })),
                )
                .child(
                    div()
                        .font_family(theme::display())
                        .font_weight(FontWeight(300.))
                        .text_size(px(if compact { 15. } else { 17. }))
                        .line_height(px(if compact { 18. } else { 20. }))
                        .when(compact, |s| s.truncate())
                        .when(!compact, |s| s.line_clamp(2))
                        .child(title),
                )
                .when_some(track.detail.clone().filter(|_| !compact), |s, detail| {
                    s.child(ui::quiet(detail, 12.))
                }),
        )
}

/// An upcoming track.
pub fn upcoming_row(track: &QueueTrack, image: Option<Arc<gpui::RenderImage>>, edge: f32) -> Div {
    div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(6.))
        .py(px(4.))
        .child(thumb(edge, image))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .flex_1()
                .child(title_line(untitled(track), 13.5))
                .when_some(track.detail.clone(), |s, detail| {
                    s.child(ui::quiet(detail, 12.))
                }),
        )
}

/// The small heading between the present and what comes next.
pub fn up_next_heading() -> Div {
    div()
        .mt(px(6.))
        .px(px(6.))
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(ui::MUTED))
        .child(text("upNext"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn track(title: Option<&str>, service: &'static str, video: Option<&str>) -> RoomTrack {
        RoomTrack {
            title: title.map(str::to_owned),
            service: Some(service),
            youtube: video.and_then(YoutubeId::parse),
        }
    }

    #[test]
    fn music_and_regular_rooms_show_played_current_and_upcoming_in_order() {
        let entry = |n: u8| {
            json!({"entryId":format!("e{n}"),"trackId":"t","sourceId":"s",
            "contributorId":"p1","artists":["Artist"],"origin":"manual","title":format!("T{n}"),
            "artworkUrl":format!("https://i.ytimg.com/vi/abcdefghi{n:02}/mqdefault.jpg")})
        };
        let music = serde_json::from_value(json!({"revision":1,"planRevision":1,
            "queue":[entry(3)],"queueTotal":1,"played":[entry(1),entry(2)],
            "current":{"entryId":"c","trackId":"t","sourceId":"s","contributorId":"p1",
                "artists":[],"origin":"manual","playbackId":"x","started":true,
                "contributorMoodIds":[],"contributorMoods":[]},
            "settings":{},"participants":[{"participantId":"p1","name":"Ana",
                "includeMoodIds":[],"excludeMoodIds":[]}]}))
        .unwrap();
        let mut room = RoomState::default();
        room.queue_mode = Some("music".into());
        room.music = Some(music);
        // Music rooms keep their history in `music.played`.
        room.played_tracks = vec![track(Some("Ignored"), "youtube", None)];
        let view = QueueView::from_room(&room);
        assert_eq!(view.played.len(), 2);
        assert_eq!(view.played[0].title.as_deref(), Some("T1"));
        assert_eq!(view.played[1].detail.as_deref(), Some("Artist · Ana"));
        assert_eq!(
            view.played[1].cover.as_ref().unwrap().as_str(),
            "abcdefghi02"
        );
        let current = view.current.as_ref().unwrap();
        assert_eq!(
            (current.title.as_deref(), current.detail.as_deref()),
            (None, Some("Ana"))
        );
        assert_eq!(view.upcoming[0].title.as_deref(), Some("T3"));
        // Steps count back from the current track, whatever a compact view shows.
        assert_eq!(view.steps(1), Some(1));
        assert_eq!(view.steps(0), Some(2));
        assert_eq!(view.recent(1).map(|(i, _)| i).collect::<Vec<_>>(), vec![1]);
        assert_eq!(view.recent(9).count(), 2);
        assert_eq!(view.covers().count(), 3);

        let mut room = RoomState::default();
        room.queue_mode = Some("manual".into());
        room.played_tracks = vec![track(Some("Old"), "youtube", Some("abcdefghijk"))];
        room.current_track = Some(track(Some("Now"), "vimeo", None));
        room.upcoming = vec![track(None, "youtube", Some("zyxwvutsrqp"))];
        let view = QueueView::from_room(&room);
        assert_eq!(view.played[0].detail.as_deref(), Some("YouTube"));
        assert_eq!(view.steps(0), Some(1));
        assert_eq!(view.covers().count(), 2);
        assert_eq!(
            view.current.as_ref().unwrap().detail.as_deref(),
            Some("Vimeo")
        );
        assert_eq!(view.upcoming[0].title, None);
        assert!(view.history());
        // Older servers: no history, nothing before the queue.
        let mut room = RoomState::default();
        room.queue_mode = Some("manual".into());
        let view = QueueView::from_room(&room);
        assert!(!view.history() && view.upcoming.is_empty());
    }

    #[test]
    fn bars_breathe_within_their_box_and_rest_when_still() {
        for step in 0..200 {
            for level in bar_levels(step as f32 * 0.037) {
                assert!((0.3..=1.0001).contains(&level), "{level}");
            }
        }
        let rest = bar_levels(0.);
        assert!((rest[0] - 0.3).abs() < 1e-4, "the first bar starts low");
        assert!(
            rest[1] > rest[0] && rest[2] > rest[1],
            "the others lag behind"
        );
        let breath = bar_levels(2. * BAR_BREATH);
        for (after, before) in breath.iter().zip(rest) {
            assert!((after - before).abs() < 1e-3, "one full breath");
        }
    }
}
