pub trait Describable {
    fn describe(&self) -> String;
}

pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Describable for Point {
    fn describe(&self) -> String {
        format!("({}, {})", self.x, self.y)
    }
}
