import base64
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import sys


def strict_document(raw):
    if len(raw) > 1024 * 1024:
        raise ValueError("payload_too_large")

    def members(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate decoded member")
            result[key] = value
        return result

    def constant(value):
        raise ValueError("nonfinite constant " + value)

    def inspect(value):
        if isinstance(value, str):
            value.encode("utf-8", errors="strict")
        elif isinstance(value, float) and not math.isfinite(value):
            raise ValueError("nonfinite number")
        elif isinstance(value, list):
            for item in value:
                inspect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                inspect(key)
                inspect(item)

    value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=members, parse_constant=constant)
    inspect(value)
    return value


def counter(value):
    if not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]{0,19}", value) is None:
        raise ValueError("noncanonical counter")
    if int(value) > 18446744073709551615:
        raise ValueError("counter out of prototype unsigned range")
    return value


def position(value):
    if not isinstance(value, dict) or set(value) != {"latitude", "longitude"}:
        raise ValueError("complete position required")
    for key, limit in (("latitude", 90), ("longitude", 180)):
        number = value[key]
        if type(number) not in (int, float) or not math.isfinite(number) or not -limit <= number <= limit:
            raise ValueError("invalid coordinate")
    return value


def main():
    cases = []

    def record(name, expected, observed):
        cases.append({"name": name, "expected": expected, "observed": observed, "passed": expected == observed})

    fixtures = [
        ("ordinary document", b'{"name":"camera"}', True, True),
        ("nested decoded duplicate", br'{"outer":{"name":1,"\u006eame":2}}', False, True),
        ("duplicate inside array", b'[{"a":1,"a":2}]', False, True),
        ("same name in separate objects", b'[{"a":1},{"a":2}]', True, True),
        ("malformed UTF-8", b'{"name":"\xff"}', False, True),
        ("overlong UTF-8", b'{"name":"\xc0\xaf"}', False, True),
        ("lone high surrogate", br'{"name":"\ud800"}', False, True),
        ("lone low surrogate key", br'{"\udc00":1}', False, True),
        ("valid surrogate pair", br'{"name":"\ud83d\ude80"}', True, True),
        ("overflowed number", b'{"value":1e400}', False, True),
        ("negative overflow", b'{"value":-1e400}', False, True),
        ("non-JSON NaN", b'{"value":NaN}', False, False),
        ("truncated document", b'{"a":', False, False),
        ("two documents", b'{} {}', False, False),
        ("unescaped control", b'{"a":"\x01"}', False, False),
        ("64-bit counter string", b'{"sequence":"9007199254740993"}', True, True),
    ]
    native = subprocess.run(
        ["node", str(Path(__file__).with_name("native.mjs"))],
        input=json.dumps([base64.b64encode(raw).decode("ascii") for _, raw, _, _ in fixtures]),
        capture_output=True, text=True, check=True, timeout=15,
    )
    ordinary = json.loads(native.stdout)
    for (name, raw, accepted, native_accepted), decoded in zip(fixtures, ordinary, strict=True):
        try:
            strict_document(raw)
            strict_accepted = True
        except (ValueError, UnicodeError):
            strict_accepted = False
        record(name, {"guarded": accepted, "native": native_accepted}, {"guarded": strict_accepted, "native": decoded["accepted"]})
    record("broken native overflow is nonfinite before JSON output", ["/value"], ordinary[9]["nonfinite"])
    record("broken native duplicate loses original fact", {"outer": {"name": 2}}, ordinary[1]["value"])
    record("broken replacement decoding changes original text", "\ufffd", ordinary[4]["value"]["name"])
    record("decimal string survives actual Node boundary", "9007199254740993", ordinary[15]["value"]["sequence"])

    for value, accepted in [("0", True), ("9007199254740993", True), ("18446744073709551615", True),
                            ("18446744073709551616", False), ("01", False), ("+1", False),
                            ("-0", False), ("1e2", False), (1, False), ("9" * 1000, False)]:
        try:
            counter(value)
            observed = True
        except ValueError:
            observed = False
        label = str(value) if len(str(value)) < 32 else "1000-digit input"
        record("prototype unsigned counter " + label, accepted, observed)

    unsafe = subprocess.run(["node", "--input-type=module", "-e",
                             "process.stdout.write(String(JSON.parse('9007199254740993')))"],
                            capture_output=True, text=True, check=True, timeout=15)
    record("broken numeric counter rounds", "9007199254740992", unsafe.stdout)
    raw = b'{"latitude":51.507400000000004,"longitude":-0.12780000000000002}'
    parsed = position(strict_document(raw))
    roundtrip = subprocess.run(["node", "--input-type=module", "-e",
                                "import{readFileSync}from'node:fs';process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8'))))"],
                               input=raw, capture_output=True, check=True, timeout=15)
    record("spatial double precision round trip", parsed, position(strict_document(roundtrip.stdout)))
    for value, accepted in [({"latitude": 0, "longitude": 0}, True),
                            ({"latitude": 51.5074}, False), ({"latitude": 91, "longitude": 0}, False),
                            ({"latitude": True, "longitude": 0}, False)]:
        try:
            position(value)
            observed = True
        except ValueError:
            observed = False
        record("position " + json.dumps(value), accepted, observed)

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE resource (body TEXT NOT NULL)")
    initial = {"description": {"name": "camera", "description": "old details"}, "position": {"latitude": 0, "longitude": 0}}
    db.execute("INSERT INTO resource VALUES (?)", (json.dumps(initial),))
    db.commit()

    def replace(raw):
        update = strict_document(raw)
        current = json.loads(db.execute("SELECT body FROM resource").fetchone()[0])
        candidate = dict(current)
        if "description" in update:
            section = update["description"]
            if not isinstance(section, dict) or not isinstance(section.get("name"), str) or not section["name"].strip():
                raise ValueError("invalid replacement description")
            candidate["description"] = section
        if "position" in update:
            candidate["position"] = position(update["position"])
        with db:
            db.execute("UPDATE resource SET body=?", (json.dumps(candidate),))
        return json.loads(db.execute("SELECT body FROM resource").fetchone()[0])

    try:
        record("omitted section preserves accepted section", initial, replace(b'{}'))
        replaced = replace(b'{"description":{"name":"renamed"}}')
        record("whole-section replacement removes omitted optional field", {"name": "renamed"}, replaced["description"])
        before = db.execute("SELECT body FROM resource").fetchone()[0]
        try:
            replace(b'{"description":{"name":"must not commit"},"position":{"latitude":51}}')
            refused = False
        except ValueError:
            refused = True
        record("invalid mixed update leaves SQL unchanged", {"refused": True, "body": before},
               {"refused": refused, "body": db.execute("SELECT body FROM resource").fetchone()[0]})
        broken_merge = {**initial["description"], **{"name": "renamed"}}
        record("broken subfield merge retains obsolete optional field", "old details", broken_merge["description"])
        values = strict_document(b'{"known_null":null}')
        record("omission and explicit null remain distinct", [False, True, None],
               ["omitted" in values, "known_null" in values, values["known_null"]])
    finally:
        db.close()

    report = {
        "experiment": "wire", "cases": cases,
        "findings": [
            {"classification": "specified implementation pitfall", "claim": "Native JSON.parse accepts decoded duplicates, replacement-decoded UTF-8, lone surrogates and overflowed numbers.", "cases": [fixtures[i][0] for i in (1, 4, 6, 9)]},
            {"classification": "specified implementation pitfall", "claim": "Converting a valid decimal counter to a JS Number changes 9007199254740993 to 9007199254740992.", "cases": ["broken numeric counter rounds"]},
            {"classification": "specified implementation pitfall", "claim": "Merging a complete Asset section retains fields the sender omitted.", "cases": ["whole-section replacement removes omitted optional field", "broken subfield merge retains obsolete optional field"]},
        ],
        "limitations": [
            "Python guards are an instrument, not a proposed SDK dependency or a qualified Go parser.",
            "Unsigned 64-bit counter range is a fixture assumption; Protocol has not selected signedness per counter.",
            "The SQL resource is a minimal specimen, not the complete UpdateAsset schema or HTTP API.",
            "Exact OpenAPI generation, SDK runtime-schema integration, streaming parse memory and full component validation are unrun.",
        ],
    }
    print(json.dumps(report, ensure_ascii=True, allow_nan=False, indent=2))
    return 0 if all(case["passed"] for case in cases) else 1


if __name__ == "__main__":
    sys.exit(main())
