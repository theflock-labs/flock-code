use ratatui::layout::Rect;
use uuid::Uuid;

pub type PaneId = String;

pub fn new_pane_id() -> PaneId {
    Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub enum SplitDir {
    Horizontal, // left | right
    Vertical,   // top  / bottom
}

/// BSP tree node.
#[derive(Debug, Clone)]
pub enum Node {
    Leaf(PaneId),
    Split {
        dir: SplitDir,
        ratio: f32, // 0.1..=0.9 — fraction given to the first child
        first: Box<Node>,
        second: Box<Node>,
    },
}

impl Node {
    pub fn new_leaf() -> (Node, PaneId) {
        let id = new_pane_id();
        (Node::Leaf(id.clone()), id)
    }

    /// Split the pane matching `target` in direction `dir`.
    /// The new (empty) pane becomes the second child.
    /// Returns (new_root, new_pane_id).
    pub fn split(&self, target: &str, dir: SplitDir) -> (Node, PaneId) {
        let new_id = new_pane_id();
        let new_root = self.split_inner(target, &dir, &new_id);
        (new_root, new_id)
    }

    fn split_inner(&self, target: &str, dir: &SplitDir, new_id: &str) -> Node {
        match self {
            Node::Leaf(id) if id == target => Node::Split {
                dir: dir.clone(),
                ratio: 0.5,
                first: Box::new(Node::Leaf(id.clone())),
                second: Box::new(Node::Leaf(new_id.to_string())),
            },
            Node::Leaf(id) => Node::Leaf(id.clone()),
            Node::Split { dir: d, ratio, first, second } => Node::Split {
                dir: d.clone(),
                ratio: *ratio,
                first: Box::new(first.split_inner(target, dir, new_id)),
                second: Box::new(second.split_inner(target, dir, new_id)),
            },
        }
    }

    /// Remove the pane matching `target`.
    /// Returns None when the entire subtree should be removed (last pane).
    pub fn remove(&self, target: &str) -> Option<Node> {
        match self {
            Node::Leaf(id) if id == target => None,
            Node::Leaf(id) => Some(Node::Leaf(id.clone())),
            Node::Split { dir, ratio, first, second } => {
                match (first.remove(target), second.remove(target)) {
                    (None, None) => None,
                    (Some(n), None) | (None, Some(n)) => Some(n),
                    (Some(f), Some(s)) => Some(Node::Split {
                        dir: dir.clone(),
                        ratio: *ratio,
                        first: Box::new(f),
                        second: Box::new(s),
                    }),
                }
            }
        }
    }

    /// Compute the screen rect for every leaf pane.
    pub fn layout(&self, area: Rect) -> Vec<(PaneId, Rect)> {
        let mut out = Vec::new();
        self.layout_inner(area, &mut out);
        out
    }

    fn layout_inner(&self, area: Rect, out: &mut Vec<(PaneId, Rect)>) {
        match self {
            Node::Leaf(id) => out.push((id.clone(), area)),
            Node::Split { dir, ratio, first, second } => {
                let (a, b) = split_rect(area, dir, *ratio);
                first.layout_inner(a, out);
                second.layout_inner(b, out);
            }
        }
    }

    /// Compute all draggable split-border rects.
    pub fn split_borders(&self, area: Rect) -> Vec<SplitBorder> {
        let mut out = Vec::new();
        self.borders_inner(area, &mut out, vec![]);
        out
    }

    fn borders_inner(&self, area: Rect, out: &mut Vec<SplitBorder>, path: Vec<bool>) {
        if let Node::Split { dir, ratio, first, second } = self {
            let (first_area, second_area) = split_rect(area, dir, *ratio);
            let border_rect = match dir {
                SplitDir::Horizontal => Rect {
                    x: first_area.x + first_area.width,
                    y: area.y,
                    width: 1,
                    height: area.height,
                },
                SplitDir::Vertical => Rect {
                    x: area.x,
                    y: first_area.y + first_area.height,
                    width: area.width,
                    height: 1,
                },
            };
            out.push(SplitBorder {
                rect: border_rect,
                dir: dir.clone(),
                area,
                path: path.clone(),
            });

            let mut p = path.clone();
            p.push(false);
            first.borders_inner(first_area, out, p);

            let mut p = path;
            p.push(true);
            second.borders_inner(second_area, out, p);
        }
    }

    /// Adjust the ratio of the Split node at `path` by `delta`.
    pub fn adjust_ratio(&mut self, path: &[bool], delta: f32) {
        match self {
            Node::Split { ratio, .. } if path.is_empty() => {
                *ratio = (*ratio + delta).clamp(0.1, 0.9);
            }
            Node::Split { first, second, .. } if !path.is_empty() => {
                let child = if path[0] { second } else { first };
                child.adjust_ratio(&path[1..], delta);
            }
            _ => {}
        }
    }

    /// Rebalance every split so each leaf pane ends up with an equal share of
    /// screen space, keeping the tree shape and split directions. A split's
    /// ratio becomes the fraction of leaves living in its first subtree, so a
    /// `leaf | (leaf | leaf)` tree resolves to 1/3 · 1/3 · 1/3 rather than the
    /// 1/2 · 1/4 · 1/4 that a naive "every ratio = 0.5" would give. Mirrors
    /// `balanceLayoutTree` in apps/flock-desktop/src/lib/layout.ts.
    pub fn reset_ratios(&mut self) {
        if let Node::Split { ratio, first, second, .. } = self {
            first.reset_ratios();
            second.reset_ratios();
            let f = first.pane_count() as f32;
            let s = second.pane_count() as f32;
            *ratio = (f / (f + s)).clamp(0.1, 0.9);
        }
    }

    pub fn all_pane_ids(&self) -> Vec<PaneId> {
        match self {
            Node::Leaf(id) => vec![id.clone()],
            Node::Split { first, second, .. } => {
                let mut ids = first.all_pane_ids();
                ids.extend(second.all_pane_ids());
                ids
            }
        }
    }

    pub fn first_pane_id(&self) -> PaneId {
        match self {
            Node::Leaf(id) => id.clone(),
            Node::Split { first, .. } => first.first_pane_id(),
        }
    }

    pub fn pane_count(&self) -> usize {
        match self {
            Node::Leaf(_) => 1,
            Node::Split { first, second, .. } => first.pane_count() + second.pane_count(),
        }
    }

    /// Find the nearest pane in `dir` from the pane at `from_id`.
    pub fn find_neighbor(&self, from_id: &str, dir: NavDir, area: Rect) -> Option<PaneId> {
        let panes = self.layout(area);
        let from_rect = panes.iter().find(|(id, _)| id == from_id)?.1;

        panes
            .into_iter()
            .filter(|(id, rect)| {
                id != from_id
                    && match dir {
                        NavDir::Right => rect.x as i32 >= (from_rect.x + from_rect.width) as i32,
                        NavDir::Left => (rect.x + rect.width) as i32 <= from_rect.x as i32,
                        NavDir::Down => rect.y as i32 >= (from_rect.y + from_rect.height) as i32,
                        NavDir::Up => (rect.y + rect.height) as i32 <= from_rect.y as i32,
                    }
            })
            .min_by_key(|(_, rect)| {
                let cx = (rect.x + rect.width / 2) as i32;
                let cy = (rect.y + rect.height / 2) as i32;
                let fx = (from_rect.x + from_rect.width / 2) as i32;
                let fy = (from_rect.y + from_rect.height / 2) as i32;
                (cx - fx).unsigned_abs() + (cy - fy).unsigned_abs()
            })
            .map(|(id, _)| id)
    }
}

fn split_rect(area: Rect, dir: &SplitDir, ratio: f32) -> (Rect, Rect) {
    match dir {
        SplitDir::Horizontal => {
            let w1 = ((area.width as f32 * ratio) as u16)
                .max(2)
                .min(area.width.saturating_sub(2));
            let w2 = area.width.saturating_sub(w1);
            (
                Rect { width: w1, ..area },
                Rect { x: area.x + w1, width: w2, ..area },
            )
        }
        SplitDir::Vertical => {
            let h1 = ((area.height as f32 * ratio) as u16)
                .max(2)
                .min(area.height.saturating_sub(2));
            let h2 = area.height.saturating_sub(h1);
            (
                Rect { height: h1, ..area },
                Rect { y: area.y + h1, height: h2, ..area },
            )
        }
    }
}

#[derive(Debug, Clone)]
pub struct SplitBorder {
    pub rect: Rect,
    pub dir: SplitDir,
    pub area: Rect,
    pub path: Vec<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NavDir {
    Left,
    Right,
    Up,
    Down,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: &str) -> Node {
        Node::Leaf(id.to_string())
    }

    fn hsplit(ratio: f32, first: Node, second: Node) -> Node {
        Node::Split {
            dir: SplitDir::Horizontal,
            ratio,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    fn vsplit(ratio: f32, first: Node, second: Node) -> Node {
        Node::Split {
            dir: SplitDir::Vertical,
            ratio,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    fn area(width: u16, height: u16) -> Rect {
        Rect { x: 0, y: 0, width, height }
    }

    fn ratio_of(node: &Node) -> f32 {
        match node {
            Node::Split { ratio, .. } => *ratio,
            Node::Leaf(_) => panic!("expected split"),
        }
    }

    fn second_of(node: &Node) -> &Node {
        match node {
            Node::Split { second, .. } => second,
            Node::Leaf(_) => panic!("expected split"),
        }
    }

    #[test]
    fn split_targets_the_right_leaf() {
        let tree = hsplit(0.5, leaf("a"), leaf("b"));
        let (tree, new_id) = tree.split("b", SplitDir::Vertical);
        assert_eq!(tree.pane_count(), 3);
        assert_eq!(tree.all_pane_ids(), vec!["a".to_string(), "b".to_string(), new_id.clone()]);
        // "a" stays a plain leaf; "b" became a vertical split with the new
        // pane as its second child.
        match &tree {
            Node::Split { first, second, .. } => {
                assert!(matches!(first.as_ref(), Node::Leaf(id) if id == "a"));
                match second.as_ref() {
                    Node::Split { dir, ratio, first, second } => {
                        assert_eq!(*dir, SplitDir::Vertical);
                        assert_eq!(*ratio, 0.5);
                        assert!(matches!(first.as_ref(), Node::Leaf(id) if id == "b"));
                        assert!(matches!(second.as_ref(), Node::Leaf(id) if *id == new_id));
                    }
                    _ => panic!("expected inner split"),
                }
            }
            _ => panic!("expected root split"),
        }
    }

    #[test]
    fn remove_collapses_split_and_last_pane_returns_none() {
        let tree = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c")));
        let tree = tree.remove("b").expect("panes remain");
        assert_eq!(tree.all_pane_ids(), vec!["a".to_string(), "c".to_string()]);
        assert!(matches!(second_of(&tree), Node::Leaf(id) if id == "c"));

        let tree = tree.remove("a").expect("panes remain");
        assert!(matches!(&tree, Node::Leaf(id) if id == "c"));
        assert!(tree.remove("c").is_none());
    }

    #[test]
    fn adjust_ratio_follows_path_and_clamps() {
        let mut tree = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c")));
        tree.adjust_ratio(&[], 0.2);
        assert!((ratio_of(&tree) - 0.7).abs() < 1e-6);
        // Clamped at 0.9 no matter how large the delta.
        tree.adjust_ratio(&[], 5.0);
        assert!((ratio_of(&tree) - 0.9).abs() < 1e-6);
        // Nested split via path; clamped at 0.1 going the other way.
        tree.adjust_ratio(&[true], -5.0);
        assert!((ratio_of(second_of(&tree)) - 0.1).abs() < 1e-6);
        // Path pointing at a leaf is a no-op.
        tree.adjust_ratio(&[false], 0.3);
        assert!((ratio_of(&tree) - 0.9).abs() < 1e-6);
    }

    // Parity case with layout.test.ts: leaf | (leaf | leaf) balances to
    // 1/3 · 1/3 · 1/3 (root ratio 1/3, inner 1/2), not 1/2 · 1/4 · 1/4.
    #[test]
    fn reset_ratios_weights_three_leaf_chain_to_thirds() {
        let mut tree = hsplit(0.8, leaf("a"), hsplit(0.2, leaf("b"), leaf("c")));
        tree.reset_ratios();
        assert!((ratio_of(&tree) - 1.0 / 3.0).abs() < 1e-6);
        assert!((ratio_of(second_of(&tree)) - 0.5).abs() < 1e-6);
    }

    // Parity case with layout.test.ts: a 4-leaf right-leaning chain
    // leaf | (leaf | (leaf | leaf)) balances to ratios 1/4, 1/3, 1/2.
    #[test]
    fn reset_ratios_weights_four_leaf_asymmetric_chain() {
        let mut tree = hsplit(
            0.5,
            leaf("a"),
            vsplit(0.5, leaf("b"), hsplit(0.5, leaf("c"), leaf("d"))),
        );
        tree.reset_ratios();
        assert!((ratio_of(&tree) - 0.25).abs() < 1e-6);
        let inner = second_of(&tree);
        assert!((ratio_of(inner) - 1.0 / 3.0).abs() < 1e-6);
        assert!((ratio_of(second_of(inner)) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn find_neighbor_navigates_directionally() {
        // 2x2 grid: a b / c d.
        let tree = vsplit(
            0.5,
            hsplit(0.5, leaf("a"), leaf("b")),
            hsplit(0.5, leaf("c"), leaf("d")),
        );
        let a = area(80, 40);
        assert_eq!(tree.find_neighbor("a", NavDir::Right, a), Some("b".to_string()));
        assert_eq!(tree.find_neighbor("a", NavDir::Down, a), Some("c".to_string()));
        assert_eq!(tree.find_neighbor("d", NavDir::Left, a), Some("c".to_string()));
        assert_eq!(tree.find_neighbor("d", NavDir::Up, a), Some("b".to_string()));
        assert_eq!(tree.find_neighbor("a", NavDir::Left, a), None);
        assert_eq!(tree.find_neighbor("a", NavDir::Up, a), None);
    }

    #[test]
    fn layout_tiles_the_area_without_overlap() {
        let mut tree = hsplit(0.5, leaf("a"), vsplit(0.5, leaf("b"), leaf("c")));
        tree.reset_ratios();
        let a = area(90, 45);
        let rects = tree.layout(a);
        assert_eq!(rects.len(), 3);

        let total: u32 = rects
            .iter()
            .map(|(_, r)| r.width as u32 * r.height as u32)
            .sum();
        assert_eq!(total, a.width as u32 * a.height as u32);

        for (i, (_, r)) in rects.iter().enumerate() {
            assert!(r.x + r.width <= a.width && r.y + r.height <= a.height);
            for (_, other) in rects.iter().skip(i + 1) {
                let x_overlap = r.x < other.x + other.width && other.x < r.x + r.width;
                let y_overlap = r.y < other.y + other.height && other.y < r.y + r.height;
                assert!(!(x_overlap && y_overlap), "rects overlap: {r:?} vs {other:?}");
            }
        }
    }

    #[test]
    fn layout_respects_ratio_and_min_size() {
        let tree = hsplit(0.3, leaf("a"), leaf("b"));
        let rects = tree.layout(area(100, 20));
        assert_eq!(rects[0].1.width, 30);
        assert_eq!(rects[1].1.width, 70);

        // An extreme ratio still leaves each side its 2-cell minimum.
        let tree = vsplit(0.9, leaf("a"), leaf("b"));
        let rects = tree.layout(area(20, 10));
        assert_eq!(rects[0].1.height, 8);
        assert_eq!(rects[1].1.height, 2);
    }
}
