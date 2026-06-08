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

pub struct Circle {
    pub radius: f64,
}

impl Describable for Circle {
    fn describe(&self) -> String {
        format!("circle(r={})", self.radius)
    }
}
