//! The animated ambience sky of one window, and the cached body drawn over it.
//!
//! Each window owns one [`Sky`] entity. Notifying it redraws that window only; the window's
//! content lives in a cached [`Body`] view, so an animation frame repaints the sky and replays
//! the body's previous layout instead of rebuilding it. Frames are scheduled by
//! [`Pacer`]: about 30 per second while the window is visible and animations are on, none at
//! all while it is minimized, hidden or cloaked (a 1 s visibility probe draws nothing), and
//! none once a static frame is shown when animations are off.
use crate::{native_window, theme};
use gpui::{
    AnyElement, App, Bounds, BoxShadow, Context, Corners, Entity, EntityId, IntoElement, Pixels,
    Render, Task, WeakEntity, Window, canvas, div, fill, linear_color_stop, linear_gradient, point,
    prelude::*, px, size,
};
use std::time::Instant;
use undertone_desktop::ambience::{self, AMBIENCES, Glow, Motion, Pacer, Rgba, Step};

/// Glows are Gaussian-blurred rectangles; this restores the peak alpha of the gallery's
/// `radial-gradient(closest-side, glow, transparent)`.
const GLOW_GAIN: f32 = 1.2;
/// Steps used to keep glows inside a rounded corner of a transparent window.
const CORNER_STEPS: usize = 6;

pub struct Sky {
    pacer: Pacer,
    looping: Option<Task<()>>,
    /// The cached body of this window: re-rendered while palette colors crossfade.
    body: Option<EntityId>,
    crossfading: bool,
    /// Corner radius of the painted area (the widget card); 0 for a framed window.
    radius: f32,
}

impl Sky {
    pub fn new(radius: f32, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe_global_in::<theme::Mood>(window, |sky, window, cx| sky.wake(window, cx))
            .detach();
        cx.observe_window_activation(window, |sky, window, cx| {
            theme::refresh_system_animations(cx);
            sky.wake(window, cx);
        })
        .detach();
        // Minimize/restore and moves between displays arrive as bounds changes.
        cx.observe_window_bounds(window, |sky, window, cx| sky.wake(window, cx))
            .detach();
        cx.defer_in(window, |sky, window, cx| sky.wake(window, cx));
        Self {
            pacer: Pacer::default(),
            looping: None,
            body: None,
            crossfading: false,
            radius,
        }
    }

    pub fn set_body(&mut self, body: EntityId) {
        self.body = Some(body);
    }

    /// Frames requested so far by this window's sky (debug counter).
    #[cfg(debug_assertions)]
    pub fn frames(&self) -> u64 {
        self.pacer.frames
    }

    /// Re-evaluates at once: drops a sleeping probe or frame timer and schedules anew.
    pub fn wake(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.looping = None;
        let delay = match self.step(window, cx) {
            Step::Frame(delay) | Step::Probe(delay) => delay,
            Step::Idle => return,
        };
        self.looping = Some(cx.spawn_in(window, async move |this, cx| {
            let mut delay = delay;
            loop {
                gpui::Timer::after(delay).await;
                match this.update_in(cx, |sky, window, cx| sky.step(window, cx)) {
                    Ok(Step::Frame(next) | Step::Probe(next)) => delay = next,
                    Ok(Step::Idle) | Err(_) => break,
                }
            }
        }));
    }

    fn step(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Step {
        let now = Instant::now();
        let animate = theme::animate(cx);
        let crossfading = theme::mood(cx).crossfade.active(now, animate);
        let visibility = native_window::visibility(window);
        let step = self.pacer.step(now, visibility, animate, crossfading);
        if let Step::Frame(_) = step {
            cx.notify();
            // Bodies follow the palette during a crossfade, plus one frame to settle on it.
            if (crossfading || self.crossfading)
                && let Some(body) = self.body
            {
                App::notify(cx, body);
            }
            self.crossfading = crossfading;
        } else if self.crossfading && !crossfading && visibility.visible() {
            if let Some(body) = self.body {
                App::notify(cx, body);
            }
            cx.notify();
            self.crossfading = false;
        }
        step
    }
}

#[derive(Clone, Copy)]
struct Layer {
    motion: Motion,
    glows: [Rgba; 3],
    opacity: f32,
}

impl Render for Sky {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let animate = theme::animate(cx);
        let fade = theme::mood(cx).crossfade;
        let progress = fade.progress(now, animate);
        let background = fade.colors(now, animate).background;
        let layer = |index: usize, opacity: f32| Layer {
            motion: AMBIENCES[index].motion,
            glows: ambience::colors(index).glows,
            opacity,
        };
        let layers = [layer(fade.from, 1. - progress), layer(fade.to, progress)];
        let time = self.pacer.time(now);
        let radius = self.radius;
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| paint(bounds, radius, background, layers, time, window),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}

fn paint(
    bounds: Bounds<Pixels>,
    radius: f32,
    background: [Rgba; 2],
    layers: [Layer; 2],
    time: f32,
    window: &mut Window,
) {
    // Gallery: linear-gradient(170deg, bg0, bg1).
    window.paint_quad(
        fill(
            bounds,
            linear_gradient(
                170.,
                linear_color_stop(theme::hsla(background[0]), 0.),
                linear_color_stop(theme::hsla(background[1]), 1.),
            ),
        )
        .corner_radii(px(radius)),
    );
    let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if width < 2. || height < 2. {
        return;
    }
    let pieces = clip_pieces(bounds, radius);
    let mut glows = Vec::with_capacity(96);
    for layer in layers {
        if layer.opacity <= 0.002 {
            continue;
        }
        ambience::scene(layer.motion, time, width, height, &mut glows);
        for glow in &glows {
            paint_glow(
                bounds,
                &pieces,
                glow,
                layer.glows[glow.tone],
                layer.opacity,
                window,
            );
        }
    }
}

fn paint_glow(
    bounds: Bounds<Pixels>,
    pieces: &[Bounds<Pixels>],
    glow: &Glow,
    tone: Rgba,
    opacity: f32,
    window: &mut Window,
) {
    let alpha = (tone.a * glow.alpha * opacity * GLOW_GAIN).min(1.);
    if alpha < 0.004 {
        return;
    }
    let short = glow.rx.min(glow.ry);
    let blur = 0.3 * short;
    let half = (
        (glow.rx - 0.5 * short).max(0.05 * short),
        (glow.ry - 0.5 * short).max(0.05 * short),
    );
    let reach = 3. * blur;
    let rect = Bounds::new(
        point(
            bounds.origin.x + px(glow.x - half.0),
            bounds.origin.y + px(glow.y - half.1),
        ),
        size(px(2. * half.0), px(2. * half.1)),
    );
    let extent = rect.dilate(px(reach));
    let shadow = [BoxShadow {
        color: theme::hsla(tone.alpha(alpha)),
        offset: point(px(0.), px(0.)),
        blur_radius: px(blur),
        spread_radius: px(0.),
    }];
    let corners = Corners::all(px(half.0.min(half.1)));
    for piece in pieces {
        if piece.intersects(&extent) {
            window.with_content_mask(Some(gpui::ContentMask { bounds: *piece }), |window| {
                window.paint_shadows(rect, corners, &shadow)
            });
        }
    }
}

/// Disjoint rectangles covering a rounded rectangle from the inside: a cross for the straight
/// parts, then a staircase in each corner, so no glow lands in a transparent corner.
fn clip_pieces(bounds: Bounds<Pixels>, radius: f32) -> Vec<Bounds<Pixels>> {
    let (x0, y0) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    let r = radius.clamp(0., w.min(h) / 2.);
    let rect =
        |x: f32, y: f32, w: f32, h: f32| Bounds::new(point(px(x), px(y)), size(px(w), px(h)));
    if r < 0.5 {
        return vec![bounds];
    }
    let mut pieces = vec![
        rect(x0, y0 + r, w, h - 2. * r),
        rect(x0 + r, y0, w - 2. * r, r),
        rect(x0 + r, y0 + h - r, w - 2. * r, r),
    ];
    let step = r / CORNER_STEPS as f32;
    for j in 0..CORNER_STEPS {
        // Distance from the outer edge of this strip to the corner's horizontal edge.
        let outer = j as f32 * step;
        let inset = r - (r * r - (r - outer).powi(2)).max(0.).sqrt();
        let strip = r - inset;
        if strip <= 0. {
            continue;
        }
        let top = y0 + outer;
        let bottom = y0 + h - outer - step;
        pieces.push(rect(x0 + inset, top, strip, step));
        pieces.push(rect(x0 + w - r, top, strip, step));
        pieces.push(rect(x0 + inset, bottom, strip, step));
        pieces.push(rect(x0 + w - r, bottom, strip, step));
    }
    pieces
}

/// A window's content as a cached view: it is rebuilt when its owner notifies or the mood
/// changes, never for an animation frame alone.
pub struct Body<T: 'static> {
    owner: WeakEntity<T>,
    render: fn(&mut T, &mut Window, &mut Context<T>) -> AnyElement,
}
impl<T: 'static> Body<T> {
    pub fn new(
        owner: &Entity<T>,
        render: fn(&mut T, &mut Window, &mut Context<T>) -> AnyElement,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(owner, |_, _, cx| cx.notify()).detach();
        cx.observe_global::<theme::Mood>(|_, cx| cx.notify())
            .detach();
        Self {
            owner: owner.downgrade(),
            render,
        }
    }
}
impl<T: 'static> Render for Body<T> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        theme::frame(cx);
        let render = self.render;
        self.owner
            .update(cx, |owner, cx| render(owner, window, cx))
            .unwrap_or_else(|_| div().into_any_element())
    }
}

/// The sky and the cached body of one window, created on its first render.
pub struct Layers<T: 'static> {
    pub sky: Entity<Sky>,
    pub body: Entity<Body<T>>,
}
impl<T: 'static> Layers<T> {
    pub fn new(
        radius: f32,
        render: fn(&mut T, &mut Window, &mut Context<T>) -> AnyElement,
        window: &mut Window,
        cx: &mut Context<T>,
    ) -> Self {
        let owner = cx.entity();
        let sky = cx.new(|cx| Sky::new(radius, window, cx));
        let body = cx.new(|cx| Body::new(&owner, render, cx));
        let id = body.entity_id();
        sky.update(cx, |sky, _| sky.set_body(id));
        Self { sky, body }
    }
    /// The body as a cached element filling its parent.
    pub fn body(&self) -> impl IntoElement {
        gpui::AnyView::from(self.body.clone()).cached(
            gpui::StyleRefinement::default()
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
        )
    }
}

/// Animation frames scheduled by a window's sky (debug builds show it in Settings).
#[cfg(debug_assertions)]
pub fn frames(sky: &Entity<Sky>, cx: &App) -> u64 {
    sky.read(cx).frames()
}
