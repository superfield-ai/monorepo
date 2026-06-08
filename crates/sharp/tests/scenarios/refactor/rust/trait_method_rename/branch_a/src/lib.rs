pub trait Describable {
    fn display(&self) -> String;
}

pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Describable for Point {
    fn display(&self) -> String {
        format!("({}, {})", self.x, self.y)
    }
}
