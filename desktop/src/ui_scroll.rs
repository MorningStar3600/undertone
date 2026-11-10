//! Reveal newly focused panel controls without fighting manual scrolling.
use gpui::{App, Bounds, Div, ElementId, FocusHandle, Pixels, ScrollHandle, Window, px};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

#[derive(Default)]
pub struct PanelScroll {
    pub handle: ScrollHandle,
    pub rendering: Cell<bool>,
    controls: RefCell<HashMap<ElementId, (FocusHandle, bool)>>,
    focused: RefCell<Option<FocusHandle>>,
    reveal: Rc<Cell<bool>>,
}

impl PanelScroll {
    pub fn begin_frame(&self, window: &Window, cx: &App) {
        self.controls.borrow_mut().retain(|_, (_, seen)| {
            let retain = *seen;
            *seen = false;
            retain
        });
        let focused = window.focused(cx);
        self.reveal.set(*self.focused.borrow() != focused);
        *self.focused.borrow_mut() = focused;
    }

    pub fn focus(&self, id: ElementId, cx: &App) -> FocusHandle {
        let mut controls = self.controls.borrow_mut();
        let (focus, seen) = controls
            .entry(id)
            .or_insert_with(|| (cx.focus_handle().tab_stop(true), true));
        *seen = true;
        focus.clone()
    }

    pub fn watch(&self, element: Div, focus: FocusHandle) -> Div {
        let handle = self.handle.clone();
        let reveal = self.reveal.clone();
        element.on_children_prepainted(move |children, window, _| {
            if !focus.is_focused(window) || !reveal.get() {
                return;
            }
            let Some(bounds) = children.first() else {
                return;
            };
            reveal.set(false);
            let offset = handle.offset();
            let next = reveal_offset(
                offset.y,
                handle.max_offset().height,
                handle.bounds(),
                *bounds,
            );
            if next != offset.y {
                let handle = handle.clone();
                let focus = focus.clone();
                window.on_next_frame(move |window, _| {
                    if focus.is_focused(window) {
                        handle.set_offset(gpui::point(offset.x, next));
                        window.refresh();
                    }
                });
            }
        })
    }

    pub fn page(&self, down: bool) {
        let offset = self.handle.offset();
        let amount = self.handle.bounds().size.height * 0.85;
        let y = (offset.y + if down { -amount } else { amount })
            .clamp(-self.handle.max_offset().height, px(0.));
        self.handle.set_offset(gpui::point(offset.x, y));
    }
}

fn reveal_offset(
    offset: Pixels,
    maximum: Pixels,
    viewport: Bounds<Pixels>,
    target: Bounds<Pixels>,
) -> Pixels {
    let top = target.top() - px(8.);
    let bottom = target.bottom() + px(8.);
    let delta = if top < viewport.top() {
        viewport.top() - top
    } else if bottom > viewport.bottom() {
        viewport.bottom() - bottom
    } else {
        px(0.)
    };
    (offset + delta).clamp(-maximum, px(0.))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds(y: f32, height: f32) -> Bounds<Pixels> {
        Bounds::new(gpui::point(px(0.), px(y)), gpui::size(px(200.), px(height)))
    }
    #[test]
    fn reveal_moves_only_enough_to_show_controls_in_either_direction() {
        let viewport = bounds(100., 200.);
        assert_eq!(
            reveal_offset(px(-100.), px(600.), viewport, bounds(320., 30.)),
            px(-158.)
        );
        assert_eq!(
            reveal_offset(px(-100.), px(600.), viewport, bounds(70., 30.)),
            px(-62.)
        );
        assert_eq!(
            reveal_offset(px(-100.), px(600.), viewport, bounds(120., 30.)),
            px(-100.)
        );
        assert_eq!(
            reveal_offset(px(-590.), px(600.), viewport, bounds(320., 30.)),
            px(-600.)
        );
        assert_eq!(
            reveal_offset(px(-10.), px(600.), viewport, bounds(70., 30.)),
            px(0.)
        );
    }
}
