//! Single-line native input built on GPUI's EntityInputHandler (including Windows IME).
//! No browser, persistence, logging, or clipboard export. Masked fields also reject paste.
use gpui::{
    App, Bounds, Context, CursorStyle, ElementInputHandler, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, IntoElement, KeyDownEvent, MouseButton, Pixels, Point, Render,
    ShapedLine, TextRun, UTF16Selection, Window, canvas, div, fill, point, prelude::*, px, rgb,
    size,
};
use std::ops::Range;

pub enum InputEvent {
    Changed,
    Submit,
}

pub struct NativeInput {
    focus: FocusHandle,
    content: String,
    placeholder: String,
    masked: bool,
    selection: Range<usize>,
    anchor: usize,
    marked: Option<Range<usize>>,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
    scroll: Pixels,
    selecting: bool,
}

impl EventEmitter<InputEvent> for NativeInput {}

fn from_utf16(value: &str, offset: usize) -> usize {
    let mut units = 0;
    for (index, ch) in value.char_indices() {
        if units >= offset {
            return index;
        }
        units += ch.len_utf16();
    }
    value.len()
}

fn to_utf16(value: &str, offset: usize) -> usize {
    value[..char_boundary(value, offset)].encode_utf16().count()
}

fn char_boundary(value: &str, offset: usize) -> usize {
    let mut offset = offset.min(value.len());
    while !value.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn fits_input(content: usize, removed: usize, added: usize) -> bool {
    content - removed + added <= 8192
}

fn masked_text(value: &str, utf16: bool) -> String {
    "•".repeat(if utf16 {
        value.encode_utf16().count()
    } else {
        value.chars().count()
    })
}

impl NativeInput {
    pub fn new(placeholder: String, masked: bool, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle().tab_stop(true),
            content: String::new(),
            placeholder,
            masked,
            selection: 0..0,
            anchor: 0,
            marked: None,
            layout: None,
            bounds: None,
            scroll: px(0.),
            selecting: false,
        }
    }

    pub fn value(&self) -> &str {
        &self.content
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.content.clear();
        self.selection = 0..0;
        self.anchor = 0;
        self.marked = None;
        self.layout = None;
        self.scroll = px(0.);
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.anchor == self.selection.start {
            self.selection.end
        } else {
            self.selection.start
        }
    }

    fn select(&mut self, offset: usize, extend: bool) {
        let offset = char_boundary(&self.content, offset);
        self.anchor = char_boundary(&self.content, self.anchor);
        if !extend {
            self.anchor = offset;
        }
        self.selection = self.anchor.min(offset)..self.anchor.max(offset);
    }

    fn utf8_range(&self, range: &Range<usize>) -> Range<usize> {
        from_utf16(&self.content, range.start)
            ..from_utf16(&self.content, range.end.max(range.start))
    }

    fn utf16_range(&self, range: &Range<usize>) -> Range<usize> {
        to_utf16(&self.content, range.start)..to_utf16(&self.content, range.end)
    }

    fn display_offset(&self, index: usize) -> usize {
        if self.masked {
            self.content[..index].chars().count() * '•'.len_utf8()
        } else {
            index
        }
    }

    fn index_at(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some(line)) = (self.bounds, self.layout.as_ref()) else {
            return char_boundary(&self.content, self.cursor());
        };
        let index = line.closest_index_for_x(position.x - bounds.left() + self.scroll);
        if self.masked {
            self.content
                .char_indices()
                .nth(index / '•'.len_utf8())
                .map_or(self.content.len(), |(index, _)| index)
        } else {
            char_boundary(&self.content, index)
        }
    }

    fn replace(&mut self, range: Range<usize>, value: &str, cx: &mut Context<Self>) {
        // Single-line and bounded; preserve composed Unicode, reject control characters.
        let value: String = value.chars().filter(|ch| !ch.is_control()).collect();
        if !fits_input(self.content.len(), range.len(), value.len()) {
            return;
        }
        self.content.replace_range(range.clone(), &value);
        // Hit-testing must never use shaped byte offsets from the previous string.
        self.layout = None;
        self.select(range.start + value.len(), false);
        self.marked = None;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Composition belongs to the OS input handler. Do not commit/submit a preedit.
        if self.marked.is_some() {
            if event.keystroke.key == "tab" {
                cx.stop_propagation();
            }
            return;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let cursor = self.cursor();
        let previous = self.content[..cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i);
        let next = self.content[cursor..]
            .chars()
            .next()
            .map_or(cursor, |ch| cursor + ch.len_utf8());
        match key {
            "a" if modifiers.control => {
                self.anchor = 0;
                self.selection = 0..self.content.len();
            }
            "c" | "x" if modifiers.control => { /* Never export field values. */ }
            "v" if modifiers.control => {
                if !self.masked
                    && let Some(value) = cx.read_from_clipboard().and_then(|item| item.text())
                {
                    self.replace(self.selection.clone(), &value, cx);
                }
            }
            "left" => self.select(
                if !modifiers.shift && !self.selection.is_empty() {
                    self.selection.start
                } else {
                    previous
                },
                modifiers.shift,
            ),
            "right" => self.select(
                if !modifiers.shift && !self.selection.is_empty() {
                    self.selection.end
                } else {
                    next
                },
                modifiers.shift,
            ),
            "home" => self.select(0, modifiers.shift),
            "end" => self.select(self.content.len(), modifiers.shift),
            "backspace" => self.replace(
                if self.selection.is_empty() {
                    previous..cursor
                } else {
                    self.selection.clone()
                },
                "",
                cx,
            ),
            "delete" => self.replace(
                if self.selection.is_empty() {
                    cursor..next
                } else {
                    self.selection.clone()
                },
                "",
                cx,
            ),
            "enter" => cx.emit(InputEvent::Submit),
            "escape" => {
                self.marked = None;
                window.blur();
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

impl EntityInputHandler for NativeInput {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.utf8_range(&range);
        *actual = Some(self.utf16_range(&range));
        Some(if self.masked {
            masked_text(&self.content[range], true)
        } else {
            self.content[range].to_owned()
        })
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16_range(&self.selection),
            reversed: self.cursor() == self.selection.start,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.utf16_range(range))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .as_ref()
            .map(|r| self.utf8_range(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        self.replace(range, text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .as_ref()
            .map(|r| self.utf8_range(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let text: String = text.chars().filter(|ch| !ch.is_control()).collect();
        if !fits_input(self.content.len(), range.len(), text.len()) {
            return;
        }
        let start = range.start;
        self.replace(range, &text, cx);
        if !text.is_empty() {
            self.marked = Some(start..start + text.len());
            if let Some(selected) = selected {
                self.anchor = start + from_utf16(&text, selected.start);
                self.select(start + from_utf16(&text, selected.end), true);
            }
        }
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.layout.as_ref()?;
        let range = self.utf8_range(&range);
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(self.display_offset(range.start)) - self.scroll,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(self.display_offset(range.end)) - self.scroll,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(to_utf16(&self.content, self.index_at(position)))
    }
}

impl Focusable for NativeInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for NativeInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input = cx.entity();
        let paint_input = input.clone();
        div()
            .id("native-input")
            .w_full()
            .h(px(44.))
            .px(px(12.))
            .py(px(10.))
            .track_focus(&self.focus)
            .tab_stop(true)
            .cursor(CursorStyle::IBeam)
            .bg(rgb(0x24211e))
            .border_1()
            .border_color(rgb(0x39342e))
            .rounded(px(12.))
            .focus(|s| s.border_color(rgb(0xffbe3d)))
            .overflow_hidden()
            .font_family("Segoe UI")
            .text_size(px(14.))
            .line_height(px(24.))
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|input, event: &gpui::MouseDownEvent, window, cx| {
                    window.focus(&input.focus);
                    input.select(input.index_at(event.position), event.modifiers.shift);
                    input.selecting = true;
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|input, event: &gpui::MouseMoveEvent, _, cx| {
                if input.selecting {
                    input.select(input.index_at(event.position), true);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|input, _, _, _| input.selecting = false),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|input, _, _, _| input.selecting = false),
            )
            .child(
                canvas(
                    move |bounds, window, cx| {
                        input.update(cx, |input, _| {
                            let empty = input.content.is_empty();
                            let display = if empty {
                                input.placeholder.clone()
                            } else if input.masked {
                                masked_text(&input.content, false)
                            } else {
                                input.content.clone()
                            };
                            let style = window.text_style();
                            let run = TextRun {
                                len: display.len(),
                                font: style.font(),
                                color: rgb(if empty { 0xaaa296 } else { 0xf7f0e6 }).into(),
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            };
                            let line = window.text_system().shape_line(
                                display.into(),
                                px(14.),
                                &[run],
                                None,
                            );
                            let cursor = if empty {
                                px(0.)
                            } else {
                                line.x_for_index(input.display_offset(input.cursor()))
                            };
                            input.scroll = input
                                .scroll
                                .max(cursor - bounds.size.width + px(2.))
                                .min(cursor)
                                .max(px(0.));
                            input.bounds = Some(bounds);
                            input.layout = Some(line.clone());
                            (
                                line,
                                cursor,
                                input.scroll,
                                input.focus.is_focused(window),
                                input.selection.clone(),
                                input.display_offset(input.selection.start),
                                input.display_offset(input.selection.end),
                                input.marked.clone().map(|range| {
                                    input.display_offset(range.start)
                                        ..input.display_offset(range.end)
                                }),
                            )
                        })
                    },
                    move |bounds,
                          (line, cursor, scroll, focused, selection, start, end, marked),
                          window,
                          cx| {
                        let focus = paint_input.read(cx).focus.clone();
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, paint_input.clone()),
                            cx,
                        );
                        let origin = point(bounds.left() - scroll, bounds.top());
                        if focused && !selection.is_empty() {
                            window.paint_quad(fill(
                                Bounds::from_corners(
                                    point(origin.x + line.x_for_index(start), bounds.top()),
                                    point(origin.x + line.x_for_index(end), bounds.bottom()),
                                ),
                                rgb(0x20354c),
                            ));
                        }
                        let _ = line.paint(origin, px(24.), window, cx);
                        if focused {
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(origin.x + cursor, bounds.top()),
                                    size(px(1.), bounds.size.height),
                                ),
                                rgb(0xffbe3d),
                            ));
                        }
                        if let Some(marked) = marked {
                            window.paint_quad(fill(
                                Bounds::from_corners(
                                    point(
                                        origin.x + line.x_for_index(marked.start),
                                        bounds.bottom() - px(1.),
                                    ),
                                    point(origin.x + line.x_for_index(marked.end), bounds.bottom()),
                                ),
                                rgb(0x8bc0ff),
                            ));
                        }
                    },
                )
                .w_full()
                .h(px(24.)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_hit_offsets_are_clamped_to_current_unicode_boundaries() {
        let current = "éa🎵";
        // The old shaped line for "a" reports byte 1, now inside the initial é.
        assert_eq!(char_boundary(current, 1), 0);
        for offset in (0..=current.len() + 1).chain([usize::MAX]) {
            let safe = char_boundary(current, offset);
            assert!(current.is_char_boundary(safe));
            assert!(safe <= current.len());
            assert_eq!(
                to_utf16(current, offset),
                current[..safe].encode_utf16().count()
            );
        }
    }

    #[test]
    fn ime_ranges_map_utf16_without_slicing_inside_unicode() {
        let value = "a🎵é中";
        for byte in value
            .char_indices()
            .map(|(index, _)| index)
            .chain([value.len()])
        {
            assert_eq!(from_utf16(value, to_utf16(value, byte)), byte);
        }
        assert_eq!(from_utf16(value, 100), value.len());
        assert!(value.is_char_boundary(from_utf16(value, 2)));
    }

    #[test]
    fn replacement_limits_also_allow_editing_a_full_field() {
        assert!(fits_input(8192, 4, 4));
        assert!(fits_input(8192, 1, 0));
        assert!(!fits_input(8192, 0, 1));
    }

    #[test]
    fn password_projection_hides_text_and_preserves_native_utf16_ranges() {
        let password = "a🎵é中";
        assert_eq!(masked_text(password, false), "••••");
        assert_eq!(
            masked_text(password, true).encode_utf16().count(),
            password.encode_utf16().count()
        );
        assert!(!masked_text(password, true).contains('a'));
    }
}
