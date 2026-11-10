
pub struct Out {
    buffer: String,
    fresh: Vec<bool>,
    keyed: bool,
}

impl Out {
    pub fn new() -> Self {
        Self { buffer: String::with_capacity(4096), fresh: Vec::new(), keyed: false }
    }

    pub fn finish(self) -> String {
        self.buffer
    }

    fn comma(&mut self) {
        if self.keyed {
            self.keyed = false;
            return;
        }
        match self.fresh.last_mut() {
            Some(first) if *first => *first = false,
            Some(_) => self.buffer.push(','),
            None => {}
        }
    }

    pub fn object(&mut self) -> &mut Self {
        self.comma();
        self.buffer.push('{');
        self.fresh.push(true);
        self
    }

    pub fn end_object(&mut self) -> &mut Self {
        self.buffer.push('}');
        self.fresh.pop();
        self
    }

    pub fn array(&mut self) -> &mut Self {
        self.comma();
        self.buffer.push('[');
        self.fresh.push(true);
        self
    }

    pub fn end_array(&mut self) -> &mut Self {
        self.buffer.push(']');
        self.fresh.pop();
        self
    }

    pub fn key(&mut self, name: &str) -> &mut Self {
        self.comma();
        escape(&mut self.buffer, name);
        self.buffer.push(':');
        self.keyed = true;
        self
    }

    pub fn str(&mut self, value: &str) -> &mut Self {
        self.comma();
        escape(&mut self.buffer, value);
        self
    }

    pub fn num(&mut self, value: f64) -> &mut Self {
        self.comma();
        if value.is_finite() {
            let rounded = (value * 1e6).round() / 1e6;
            if rounded == rounded.trunc() && rounded.abs() < 1e15 {
                self.buffer.push_str(&format!("{}", rounded as i64));
            } else {
                self.buffer.push_str(&format!("{rounded}"));
            }
        } else {
            self.buffer.push_str("null");
        }
        self
    }

    pub fn int(&mut self, value: i64) -> &mut Self {
        self.comma();
        self.buffer.push_str(&format!("{value}"));
        self
    }

    pub fn bool(&mut self, value: bool) -> &mut Self {
        self.comma();
        self.buffer.push_str(if value { "true" } else { "false" });
        self
    }

    pub fn null(&mut self) -> &mut Self {
        self.comma();
        self.buffer.push_str("null");
        self
    }

    pub fn field_str(&mut self, name: &str, value: &str) -> &mut Self {
        self.key(name).str(value)
    }

    pub fn field_num(&mut self, name: &str, value: f64) -> &mut Self {
        self.key(name).num(value)
    }

    pub fn field_int(&mut self, name: &str, value: i64) -> &mut Self {
        self.key(name).int(value)
    }

    pub fn field_bool(&mut self, name: &str, value: bool) -> &mut Self {
        self.key(name).bool(value)
    }

    pub fn field_opt_str(&mut self, name: &str, value: Option<&str>) -> &mut Self {
        match value {
            Some(text) => self.key(name).str(text),
            None => self.key(name).null(),
        }
    }

    pub fn field_opt_num(&mut self, name: &str, value: Option<f64>) -> &mut Self {
        match value {
            Some(number) => self.key(name).num(number),
            None => self.key(name).null(),
        }
    }
}

impl Default for Out {
    fn default() -> Self {
        Self::new()
    }
}

fn escape(into: &mut String, value: &str) {
    into.push('"');
    for c in value.chars() {
        match c {
            '"' => into.push_str("\\\""),
            '\\' => into.push_str("\\\\"),
            '\n' => into.push_str("\\n"),
            '\r' => into.push_str("\\r"),
            '\t' => into.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                into.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => into.push(c),
        }
    }
    into.push('"');
}
