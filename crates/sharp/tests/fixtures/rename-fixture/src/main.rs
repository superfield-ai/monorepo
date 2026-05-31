/// Fixture for rename enumeration tests.
///
/// The function `compute_value` is renamed to `calculate_result` on the
/// "ours" branch.  The "theirs" branch edits the body of `compute_value`.
/// Sharp should propagate the rename to the theirs-branch edit site.

fn compute_value(x: i32) -> i32 {
    x * 2
}

fn main() {
    let result = compute_value(21);
    println!("result = {result}");
}
