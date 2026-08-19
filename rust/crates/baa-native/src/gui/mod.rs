//! The window model, with no operating system in it.
//!
//! A Baa application describes a tree of widgets and asks for it to be shown.
//! This module owns that tree, works out where everything goes, and queues the
//! events that come back. It knows nothing about Win32, which is what makes it
//! testable without a screen and portable in principle: adding a second
//! backend means implementing `Backend`, not rewriting the layout.
//!
//! The tree is an arena of `Widget`s addressed by index rather than a tree of
//! `Rc<RefCell<..>>`. A widget refers to its parent and its children, which is
//! a cycle, and an arena is how you have one of those in Rust without
//! pretending you do not.
//!
//! Layout is one pass, top down. Each container hands its children a rectangle
//! and each child either takes its natural size or a share of what is left,
//! in proportion to its weight. That is enough for the applications in
//! `examples/native/`, and it is the model that a grid of calculator buttons,
//! a text editor with a toolbar and a list with a detail pane all fit.

use std::collections::VecDeque;

#[cfg(windows)]
pub mod win32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Window,
    Row,
    Column,
    Label,
    Button,
    Edit,
    /// A multi-line editor with its own scrollbars.
    TextArea,
    List,
    Checkbox,
    /// Empty space that takes a share of the layout.
    Spacer,
    /// A menu on the window's menu bar. Not laid out: the operating system
    /// draws the bar itself, which is why a menu is a widget with no rectangle.
    Menu,
    /// An entry in a menu. Fires the same `click` event a button does.
    MenuItem,
    /// A dividing line in a menu.
    Separator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Click,
    /// The text of an edit changed.
    Changed,
    /// A list selection changed.
    Select,
    /// A checkbox was toggled.
    Toggle,
    /// The window was asked to close. A handler can decide what that means.
    Close,
    /// A timer came due. `Event::widget` carries the timer's id, not a widget's.
    Tick,
}

#[derive(Clone, Copy, Debug)]
pub struct Event {
    pub widget: usize,
    pub kind: EventKind,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct Widget {
    pub kind: Kind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub text: String,
    /// Share of the leftover space along the parent's axis. `0` means the
    /// widget takes its natural size.
    pub weight: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub padding: f64,
    pub spacing: f64,
    pub align: Align,
    pub font_size: f64,
    pub enabled: bool,
    pub checked: bool,
    pub items: Vec<String>,
    pub selected: i64,
    /// Whatever the backend needs to find this widget again. An `HWND` on
    /// Windows; zero before the window is realised.
    pub handle: usize,
    pub rect: Rect,
    /// True when the backend still has to be told about a change.
    pub dirty: bool,
}

impl Widget {
    fn new(kind: Kind, parent: Option<usize>) -> Widget {
        Widget {
            kind,
            parent,
            children: Vec::new(),
            text: String::new(),
            weight: 0.0,
            width: None,
            height: None,
            padding: if matches!(kind, Kind::Window) { 12.0 } else { 0.0 },
            spacing: 8.0,
            align: Align::Start,
            font_size: 0.0,
            enabled: true,
            checked: false,
            items: Vec::new(),
            selected: -1,
            handle: 0,
            rect: Rect::default(),
            dirty: false,
        }
    }

    /// Natural height for a widget that is not sharing leftover space. These
    /// are in layout units, which the backend scales for the monitor's DPI.
    fn natural_height(&self) -> f64 {
        if let Some(height) = self.height {
            return height;
        }
        match self.kind {
            Kind::Label => 22.0,
            Kind::Button => 32.0,
            Kind::Edit => 26.0,
            Kind::Checkbox => 22.0,
            Kind::TextArea | Kind::List => 120.0,
            Kind::Spacer | Kind::Menu | Kind::MenuItem | Kind::Separator => 0.0,
            _ => 0.0,
        }
    }

    fn natural_width(&self) -> f64 {
        if let Some(width) = self.width {
            return width;
        }
        match self.kind {
            // A rough advance width per character: enough for a row of short
            // buttons to size sensibly without asking the backend to measure
            // text, which would drag font metrics into this module.
            Kind::Button | Kind::Label | Kind::Checkbox => {
                (self.text.chars().count() as f64 * 8.0 + 24.0).max(48.0)
            }
            Kind::Edit => 160.0,
            Kind::TextArea | Kind::List => 200.0,
            Kind::Spacer | Kind::Menu | Kind::MenuItem | Kind::Separator => 0.0,
            _ => 0.0,
        }
    }
}

/// A timer the application asked for.
///
/// Timers are not widgets: they have no place in the layout and nothing on
/// screen. They are ids with an interval, and an `Event` with kind `Tick`
/// carries the id in the field a widget's events use, so the handler table
/// works for both without a second one.
#[derive(Clone, Copy, Debug)]
pub struct Timer {
    pub id: usize,
    pub interval: u32,
    /// `false` for `barn.after`, which fires once and then cancels itself.
    pub repeating: bool,
}

pub struct Ui {
    pub widgets: Vec<Widget>,
    pub events: VecDeque<Event>,
    /// Windows in creation order. Closing the last one ends the program.
    pub windows: Vec<usize>,
    pub open: usize,
    pub timers: Vec<Timer>,
    /// Ids are never reused, so a cancelled timer's id cannot come back and
    /// deliver a tick to whatever took its place.
    next_timer: usize,
}

impl Default for Ui {
    fn default() -> Ui {
        Ui::new()
    }
}

impl Ui {
    pub fn new() -> Ui {
        Ui {
            widgets: Vec::new(),
            events: VecDeque::new(),
            windows: Vec::new(),
            open: 0,
            timers: Vec::new(),
            next_timer: 1,
        }
    }

    pub fn add(&mut self, kind: Kind, parent: Option<usize>) -> usize {
        let id = self.widgets.len();
        self.widgets.push(Widget::new(kind, parent));
        if let Some(parent) = parent {
            self.widgets[parent].children.push(id);
        }
        if kind == Kind::Window {
            self.windows.push(id);
            self.open += 1;
        }
        id
    }

    pub fn get(&self, id: usize) -> Option<&Widget> {
        self.widgets.get(id)
    }

    pub fn get_mut(&mut self, id: usize) -> Option<&mut Widget> {
        self.widgets.get_mut(id)
    }

    /// The window a widget belongs to, walking up the tree.
    pub fn window_of(&self, mut id: usize) -> Option<usize> {
        loop {
            let widget = self.widgets.get(id)?;
            if widget.kind == Kind::Window {
                return Some(id);
            }
            id = widget.parent?;
        }
    }

    /// Register a timer and return its id.
    pub fn add_timer(&mut self, interval: u32, repeating: bool) -> usize {
        let id = self.next_timer;
        self.next_timer += 1;
        self.timers.push(Timer { id, interval, repeating });
        id
    }

    /// Forget a timer. True when there was one to forget.
    pub fn remove_timer(&mut self, id: usize) -> bool {
        let before = self.timers.len();
        self.timers.retain(|timer| timer.id != id);
        self.timers.len() != before
    }

    pub fn timer(&self, id: usize) -> Option<Timer> {
        self.timers.iter().find(|timer| timer.id == id).copied()
    }

    pub fn push_event(&mut self, widget: usize, kind: EventKind) {
        self.events.push_back(Event { widget, kind });
    }

    /// Places every widget inside a window, given the window's client area.
    ///
    /// Called on every resize, so it allocates nothing and touches each widget
    /// once.
    pub fn layout(&mut self, window: usize, width: f64, height: f64) {
        let padding = self.widgets[window].padding;
        let area = Rect {
            x: padding,
            y: padding,
            width: (width - padding * 2.0).max(0.0),
            height: (height - padding * 2.0).max(0.0),
        };
        self.widgets[window].rect = Rect { x: 0.0, y: 0.0, width, height };
        let children = self.widgets[window].children.clone();
        let spacing = self.widgets[window].spacing;
        self.place_children(&children, area, spacing, true);
    }

    fn place_children(&mut self, children: &[usize], area: Rect, spacing: f64, vertical: bool) {
        if children.is_empty() {
            return;
        }
        // Menus live on the window's bar, not in the layout, so they are not
        // counted when the space is shared out.
        let children: Vec<usize> = children
            .iter()
            .copied()
            .filter(|id| !matches!(self.widgets[*id].kind, Kind::Menu | Kind::MenuItem | Kind::Separator))
            .collect();
        if children.is_empty() {
            return;
        }
        let children = &children[..];
        let gaps = spacing * (children.len().saturating_sub(1)) as f64;
        let available = if vertical { area.height } else { area.width } - gaps;

        let mut fixed_total = 0.0;
        let mut weight_total = 0.0;
        for id in children {
            let widget = &self.widgets[*id];
            if widget.weight > 0.0 {
                weight_total += widget.weight;
            } else {
                fixed_total += self.natural_along(*id, vertical);
            }
        }
        let leftover = (available - fixed_total).max(0.0);

        let mut offset = 0.0;
        for id in children {
            let widget = &self.widgets[*id];
            let along = if widget.weight > 0.0 && weight_total > 0.0 {
                leftover * (widget.weight / weight_total)
            } else {
                self.natural_along(*id, vertical)
            };
            let rect = if vertical {
                Rect { x: area.x, y: area.y + offset, width: area.width, height: along }
            } else {
                Rect { x: area.x + offset, y: area.y, width: along, height: area.height }
            };
            offset += along + spacing;

            self.widgets[*id].rect = rect;
            let kind = self.widgets[*id].kind;
            if matches!(kind, Kind::Row | Kind::Column) {
                let padding = self.widgets[*id].padding;
                let inner = Rect {
                    x: rect.x + padding,
                    y: rect.y + padding,
                    width: (rect.width - padding * 2.0).max(0.0),
                    height: (rect.height - padding * 2.0).max(0.0),
                };
                let grandchildren = self.widgets[*id].children.clone();
                let child_spacing = self.widgets[*id].spacing;
                self.place_children(&grandchildren, inner, child_spacing, kind == Kind::Column);
            }
        }
    }

    /// A widget's natural size along the axis it is being laid out on. A
    /// container's is the sum of its children plus the gaps between them, so a
    /// row of buttons inside a column takes exactly one button's height.
    fn natural_along(&self, id: usize, vertical: bool) -> f64 {
        let widget = &self.widgets[id];
        match widget.kind {
            Kind::Row | Kind::Column => {
                let explicit = if vertical { widget.height } else { widget.width };
                if let Some(size) = explicit {
                    return size;
                }
                let same_axis = (widget.kind == Kind::Column) == vertical;
                let mut total = widget.padding * 2.0;
                if same_axis {
                    total += widget.spacing * widget.children.len().saturating_sub(1) as f64;
                    for child in &widget.children {
                        total += self.natural_along(*child, vertical);
                    }
                } else {
                    let largest = widget
                        .children
                        .iter()
                        .map(|child| self.natural_along(*child, vertical))
                        .fold(0.0_f64, f64::max);
                    total += largest;
                }
                total
            }
            _ => {
                if vertical {
                    widget.natural_height()
                } else {
                    widget.natural_width()
                }
            }
        }
    }
}

/// What a platform backend has to provide.
///
/// One implementation exists, for Win32. The trait is here so that the second
/// one is an addition rather than a rewrite, and so this file can be read
/// without knowing any Windows API.
pub trait Backend {
    /// Realises a window and everything under it.
    fn create_window(&mut self, ui: &mut Ui, window: usize) -> Result<(), String>;
    /// Pushes changed text, enabled state and list contents to the screen.
    fn sync(&mut self, ui: &mut Ui);
    /// Runs one turn of the event loop, filling `ui.events`. Returns false
    /// when the application should stop.
    fn pump(&mut self, ui: &mut Ui) -> bool;
    fn close(&mut self, ui: &mut Ui, window: usize);
    /// A modal message box. Returns true for OK/Yes.
    fn message(&mut self, ui: &Ui, window: usize, title: &str, text: &str, kind: &str) -> bool;
    /// A file dialog. `save` picks the save variant. Returns the chosen path.
    fn file_dialog(&mut self, ui: &Ui, window: usize, save: bool, filter: &str) -> Option<String>;
    /// Ask the platform to deliver `Tick` events for a timer. False when it
    /// could not, which is reported rather than silently never firing.
    fn start_timer(&mut self, ui: &mut Ui, id: usize, interval: u32) -> bool;
    fn stop_timer(&mut self, ui: &mut Ui, id: usize);
    fn clipboard_get(&mut self) -> Option<String>;
    fn clipboard_set(&mut self, text: &str) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Timers are ids with an interval. Nothing about them needs a screen, so
    /// the model is tested without one.
    #[test]
    fn hands_out_timer_ids_that_are_never_reused() {
        let mut ui = Ui::new();
        let first = ui.add_timer(100, true);
        let second = ui.add_timer(50, false);
        assert_ne!(first, second);

        assert!(ui.remove_timer(first));
        // The next id is a new one. Reusing `first` would let a tick that was
        // already in flight arrive at whatever took its place.
        let third = ui.add_timer(100, true);
        assert_ne!(third, first);
        assert_ne!(third, second);
    }

    #[test]
    fn remembers_whether_a_timer_repeats() {
        let mut ui = Ui::new();
        let repeating = ui.add_timer(100, true);
        let once = ui.add_timer(100, false);
        assert!(ui.timer(repeating).unwrap().repeating);
        assert!(!ui.timer(once).unwrap().repeating);
        assert_eq!(ui.timer(repeating).unwrap().interval, 100);
    }

    #[test]
    fn removing_a_timer_twice_is_not_an_error() {
        // A one-shot cancels itself once it has fired, and a handler that also
        // cancels it should not have to know which happened first.
        let mut ui = Ui::new();
        let id = ui.add_timer(10, false);
        assert!(ui.remove_timer(id));
        assert!(!ui.remove_timer(id));
        assert!(ui.timer(id).is_none());
    }

    #[test]
    fn a_tick_carries_the_timer_id_where_a_widget_id_would_go() {
        let mut ui = Ui::new();
        let id = ui.add_timer(10, true);
        ui.push_event(id, EventKind::Tick);
        let event = ui.events.pop_front().expect("a tick");
        assert_eq!(event.kind, EventKind::Tick);
        assert_eq!(event.widget, id);
    }

    /// A column of three buttons in a 300x300 window: fixed heights, stacked,
    /// with the spacing between them and the window's padding around them.
    #[test]
    fn stacks_a_column() {
        let mut ui = Ui::new();
        let window = ui.add(Kind::Window, None);
        let column = ui.add(Kind::Column, Some(window));
        ui.get_mut(column).unwrap().weight = 1.0;
        let a = ui.add(Kind::Button, Some(column));
        let b = ui.add(Kind::Button, Some(column));
        ui.layout(window, 300.0, 300.0);

        let first = ui.get(a).unwrap().rect;
        let second = ui.get(b).unwrap().rect;
        assert_eq!(first.x, 12.0, "window padding on the left");
        assert_eq!(first.y, 12.0, "window padding on the top");
        assert_eq!(first.height, 32.0, "a button's natural height");
        assert_eq!(second.y, 12.0 + 32.0 + 8.0, "below the first, one spacing down");
        assert_eq!(first.width, 300.0 - 24.0, "fills the width of the column");
    }

    /// Weights divide what is left after the fixed children have taken theirs.
    #[test]
    fn weights_share_the_remainder() {
        let mut ui = Ui::new();
        let window = ui.add(Kind::Window, None);
        ui.get_mut(window).unwrap().padding = 0.0;
        let column = ui.add(Kind::Column, Some(window));
        ui.get_mut(column).unwrap().weight = 1.0;
        ui.get_mut(column).unwrap().spacing = 0.0;

        let fixed = ui.add(Kind::Button, Some(column));
        let one = ui.add(Kind::List, Some(column));
        let two = ui.add(Kind::List, Some(column));
        ui.get_mut(one).unwrap().weight = 1.0;
        ui.get_mut(two).unwrap().weight = 3.0;

        ui.layout(window, 200.0, 132.0);
        assert_eq!(ui.get(fixed).unwrap().rect.height, 32.0);
        assert_eq!(ui.get(one).unwrap().rect.height, 25.0, "a quarter of the 100 left");
        assert_eq!(ui.get(two).unwrap().rect.height, 75.0, "three quarters of it");
    }

    /// A row inside a column takes one row's height, not the sum of its
    /// children's heights. Getting this wrong makes a grid of buttons grow
    /// down the screen, which is exactly what the calculator would do.
    #[test]
    fn a_row_is_as_tall_as_its_tallest_child() {
        let mut ui = Ui::new();
        let window = ui.add(Kind::Window, None);
        ui.get_mut(window).unwrap().padding = 0.0;
        let column = ui.add(Kind::Column, Some(window));
        ui.get_mut(column).unwrap().weight = 1.0;
        let row = ui.add(Kind::Row, Some(column));
        for _ in 0..4 {
            ui.add(Kind::Button, Some(row));
        }
        ui.layout(window, 400.0, 400.0);
        assert_eq!(ui.get(row).unwrap().rect.height, 32.0);
        let first = ui.get(ui.get(row).unwrap().children[0]).unwrap().rect;
        let second = ui.get(ui.get(row).unwrap().children[1]).unwrap().rect;
        assert!(second.x > first.x, "children run across, not down");
        assert_eq!(first.y, second.y, "and share a baseline");
    }
}
