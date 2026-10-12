//! Read the first worksheet of an `.xlsx` workbook as CSV text (mail-merge recipient lists).

use crate::package::Package;
use crate::xml::El;

fn kid<'a>(e: &'a El, name: &str) -> Option<&'a El> {
    e.els().find(|c| c.local() == name)
}

fn si_text(si: &El) -> String {
    let mut s = String::new();
    for c in si.els() {
        match c.local() {
            "t" => s.push_str(&c.text()),
            "r" => {
                for t in c.els().filter(|t| t.local() == "t") {
                    s.push_str(&t.text());
                }
            }
            _ => {}
        }
    }
    s
}

/// 0-based column of a cell reference such as `B7`.
fn col_index(r: &str) -> usize {
    let mut n = 0usize;
    for ch in r.chars().take_while(|c| c.is_ascii_alphabetic()) {
        n = n.saturating_mul(26).saturating_add(ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.saturating_sub(1)
}

fn builtin_date_format(id: u32) -> bool {
    matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58)
}

fn custom_date_format(code: &str) -> bool {
    let mut plain = String::new();
    let mut quoted = false;
    let mut bracket = false;
    for ch in code.to_ascii_lowercase().chars() {
        match ch {
            '"' => quoted = !quoted,
            '[' => bracket = true,
            ']' => bracket = false,
            c if !quoted && !bracket => plain.push(c),
            _ => {}
        }
    }
    plain.contains('y') || plain.contains('d')
}

/// Excel serial day number to "Month D, YYYY".
fn serial_to_date(serial: f64) -> Option<String> {
    if !(1.0..2_958_466.0).contains(&serial) {
        return None;
    }
    let days = serial.floor() as i64 - 25_569; // days since 1970-01-01
    // Civil-from-days (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    Some(format!("{} {}, {}", MONTHS.get((m - 1) as usize)?, d, y))
}

fn csv_field(s: &str, out: &mut String) {
    if s.contains([',', '"', '\n', '\r']) {
        out.push('"');
        out.push_str(&s.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(s);
    }
}

/// The first worksheet of the workbook as CSV (dates written as "June 29, 2026").
pub fn xlsx_to_csv(bytes: &[u8]) -> Result<String, String> {
    let pkg = Package::open(bytes).map_err(|e| e.to_string())?;
    let shared: Vec<String> = match pkg.xml("xl/sharedStrings.xml").map_err(|e| e.to_string())? {
        Some(root) => root.els().filter(|e| e.local() == "si").map(si_text).collect(),
        None => Vec::new(),
    };
    // Which cell formats (xf index) are dates.
    let mut date_xf: Vec<bool> = Vec::new();
    if let Some(styles) = pkg.xml("xl/styles.xml").map_err(|e| e.to_string())? {
        let mut custom: Vec<(u32, bool)> = Vec::new();
        if let Some(fmts) = kid(&styles, "numFmts") {
            for f in fmts.els().filter(|f| f.local() == "numFmt") {
                if let (Some(id), Some(code)) = (f.attr("numFmtId").and_then(|v| v.parse::<u32>().ok()), f.attr("formatCode")) {
                    custom.push((id, custom_date_format(code)));
                }
            }
        }
        if let Some(xfs) = kid(&styles, "cellXfs") {
            for xf in xfs.els().filter(|x| x.local() == "xf") {
                let id = xf.attr("numFmtId").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
                let is_date = builtin_date_format(id) || custom.iter().any(|(c, d)| *c == id && *d);
                date_xf.push(is_date);
            }
        }
    }
    let sheet = (1..=30)
        .find_map(|n| pkg.xml(&format!("xl/worksheets/sheet{n}.xml")).ok().flatten())
        .ok_or_else(|| "this workbook has no worksheet".to_string())?;
    let data = kid(&sheet, "sheetData").ok_or_else(|| "the worksheet is empty".to_string())?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in data.els().filter(|r| r.local() == "row") {
        let mut cells: Vec<String> = Vec::new();
        let mut next = 0usize;
        for c in row.els().filter(|c| c.local() == "c") {
            let col = c.attr("r").map(col_index).unwrap_or(next);
            if col > 512 {
                continue;
            }
            while cells.len() < col {
                cells.push(String::new());
            }
            let v = kid(c, "v").map(|v| v.text()).unwrap_or_default();
            let text = match c.attr("t") {
                Some("s") => v.trim().parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default(),
                Some("inlineStr") => kid(c, "is").map(si_text).unwrap_or_default(),
                Some("b") => (if v.trim() == "1" { "TRUE" } else { "FALSE" }).to_string(),
                Some("str") | Some("e") => v,
                _ => {
                    let styled_date = c.attr("s").and_then(|s| s.parse::<usize>().ok()).is_some_and(|i| date_xf.get(i).copied().unwrap_or(false));
                    match v.trim().parse::<f64>() {
                        Ok(n) if styled_date => serial_to_date(n).unwrap_or(v),
                        _ => v,
                    }
                }
            };
            if cells.len() == col {
                cells.push(text);
            } else if let Some(slot) = cells.get_mut(col) {
                *slot = text;
            }
            next = col + 1;
        }
        rows.push(cells);
        if rows.len() > 20_000 {
            break;
        }
    }
    while rows.last().is_some_and(|r| r.iter().all(|c| c.trim().is_empty())) {
        rows.pop();
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if rows.is_empty() || width == 0 {
        return Err("the worksheet has no data".to_string());
    }
    let mut out = String::new();
    for r in rows {
        for i in 0..width {
            if i > 0 {
                out.push(',');
            }
            csv_field(r.get(i).map(String::as_str).unwrap_or(""), &mut out);
        }
        out.push('\n');
    }
    Ok(out)
}
