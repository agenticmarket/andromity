"""Adversarial tests for the TOML writer used without tomli-w and for repairing configs the old writer damaged."""
import enum
import importlib.util
import io
import math
import os
import random
import sys
import time
import tomllib
import uuid
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path

import pytest
import tomli_w

import andromity.config as config_module
from andromity.config import ConfigManager
from andromity.server import rpc_handler as rpc
from andromity.server.rpc_handler import JsonRpcHandler

CONFIG_SOURCE = Path(config_module.__file__)
OLD_MTIME_NS = 978307200 * 10**9


@pytest.fixture(autouse=True)
def _isolated_and_saving(tmp_path, monkeypatch):
    assert Path(os.environ["ANDROMITY_CONFIG_DIR"]).is_relative_to(tmp_path)
    assert config_module.config.config_path.is_relative_to(tmp_path)
    monkeypatch.delenv("ANDROMITY_SKIP_CONFIG_SAVE", raising=False)


@pytest.fixture
def fallback(tmp_path, monkeypatch):
    """config.py imported again with `import tomli_w` failing, so it uses its own writer."""
    conf_dir = tmp_path / "fallback-import"
    conf_dir.mkdir()
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(conf_dir))
    monkeypatch.setitem(sys.modules, "tomli_w", None)
    spec = importlib.util.spec_from_file_location(f"_config_without_tomli_w_{uuid.uuid4().hex}", CONFIG_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.tomli_w.__name__ == "_TomliWFallback"
    assert module.config.config_dir == conf_dir
    return module


@pytest.fixture(params=["tomli_w", "fallback"])
def manager_cls(request, tmp_path, monkeypatch):
    """ConfigManager as installed (tomli-w present) and as it runs without tomli-w."""
    if request.param == "tomli_w":
        assert config_module.tomli_w is tomli_w
        return ConfigManager
    return request.getfixturevalue("fallback").ConfigManager


def old_fallback_dumps(d: dict) -> str:
    """The fallback writer as it was before the fix, used to produce damaged files."""
    def fmt(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        elif isinstance(v, (int, float)):
            return str(v)
        elif isinstance(v, list):
            return "[" + ", ".join(fmt(i) for i in v) + "]"
        s = str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        return f'"{s}"'

    lines, tables, array_tables = [], [], []
    for k, v in d.items():
        if isinstance(v, dict):
            tables.append((k, v))
        elif isinstance(v, list) and v and all(isinstance(i, dict) for i in v):
            array_tables.append((k, v))
        else:
            lines.append(f"{k} = {fmt(v)}")
    for k, v in tables:
        lines.append(f"\n[{k}]")
        for sub_k, sub_v in v.items():
            lines.append(f"{sub_k} = {fmt(sub_v)}")
    for k, items in array_tables:
        for item in items:
            lines.append(f"\n[[{k}]]")
            for sub_k, sub_v in item.items():
                lines.append(f"{sub_k} = {fmt(sub_v)}")
    return "\n".join(lines) + "\n"


def same(a, b) -> bool:
    """Equality that also compares types, float signs and NaN."""
    if isinstance(a, float) and isinstance(b, float):
        if math.isnan(a) or math.isnan(b):
            return math.isnan(a) and math.isnan(b)
        return a == b and math.copysign(1.0, a) == math.copysign(1.0, b)
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


def assert_round_trip(fb, data, expected=None):
    expected = data if expected is None else expected
    text = fb.tomli_w.dumps(data)
    buf = io.BytesIO()
    fb.tomli_w.dump(data, buf)
    assert buf.getvalue() == text.encode("utf-8")
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        pytest.fail(f"invalid TOML ({e}) written for {data!r}:\n{text}")
    assert same(parsed, expected), f"round trip changed {data!r}\nwritten:\n{text}\nread back: {parsed!r}"


def snapshot(path: Path):
    return path.read_bytes(), path.stat().st_mtime_ns


def age(path: Path):
    os.utime(path, ns=(OLD_MTIME_NS, OLD_MTIME_NS))


def write_config(directory: Path, text: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "config.toml"
    path.write_bytes(text.encode("utf-8"))
    age(path)
    return path


def load_global_config(text: str):
    cfg = config_module.config
    assert cfg.config_path.parent == Path(os.environ["ANDROMITY_CONFIG_DIR"])
    cfg.config_path.write_bytes(text.encode("utf-8"))
    cfg._load()
    assert cfg.load_error is None
    return cfg


NASTY_STRINGS = [
    "", " ", "plain", 'say "hi"', "back\\slash", "trailing\\", "\\", '"', '\\"', "'", "'''", '"""', '"""\n\'\'\'',
    "line1\nline2", "crlf\r\n", "\r", "tab\tsep", "\b\f", "\x00", "nul\x00mid", "\x01\x02\x1b\x1f", "\x7f", "\x80\x9f\xa0",
    "\u00e9t\u00e9", "\u4e2d\u6587", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629", "\U0001F600",
    "\U0001F468\u200d\U0001F469\u200d\U0001F467", "\u2028\u2029", "\ufeff", "\ufffe", "\U0010FFFF", "\ue000",
    "C:\\Users\\name\\{'x'}", "D:\\\\saas\\\\agent", "# not a comment", "key = value", "[table]", "[[array]]",
    '{"json": true}', "{'path': 'x'}", "${HOME}", "$(rm -rf /)", "`whoami`", "\\u0041", "\\n", "\\\\u0000",
    "a" * 5000, "\\" * 33, '"' * 33,
]

HARD_KEYS = [
    "", " ", "a b", "a.b", ".", "..", "a.b.c", "\u043a\u043b\u044e\u0447", "\U0001F511", '"', "'", "\\", "\n", "\t", "\x00",
    "\x7f", "[x]", "]]", "=", "#", "a=b", "2026-10-28", "1979-05-27T07:32:00Z", "1.5", "+1", "true", "inf", "nan",
    "-", "_", "0", "A-Z_a-z-09", 'with"quote', "p" + "f" * 15, "\ufeffbom",
]


# ── 1. The writer used without tomli-w ────────────────────────────────────────────────────


def test_fallback_is_the_writer_under_test(fallback):
    assert fallback.tomli_w is not tomli_w
    assert fallback.ConfigManager is not ConfigManager


@pytest.mark.parametrize("s", NASTY_STRINGS, ids=range(len(NASTY_STRINGS)))
def test_fallback_round_trips_any_string_value(fallback, s):
    data = {
        "root": s,
        "list": [s, s, [s]],
        "t": {"v": s, "deep": {"v": s, "deeper": {"v": [s]}}},
        "aot": [{"v": s}, {"w": [s], "x": {"y": s}}],
        "mixed": [s, {"v": s, "n": [{"m": s}]}, 1],
    }
    assert_round_trip(fallback, data)


@pytest.mark.parametrize("k", HARD_KEYS, ids=range(len(HARD_KEYS)))
def test_fallback_round_trips_keys_that_need_quoting(fallback, k):
    assert_round_trip(fallback, {
        k: k,
        "table": {k: {k: k, "x": [k]}},
        "aot": [{k: [k]}, {k: {k: 1}}],
        "inline": [1, {k: k, "n": {k: True}}],
    })
    assert_round_trip(fallback, {k: {k: {"v": 1}, "aot": [{k: {}}]}})
    assert_round_trip(fallback, {k: [{k: [{k: 2}]}]})


@pytest.mark.parametrize("v", [
    0, 1, -1, 2**31, -2**31, 2**63 - 1, -2**63, 10**18,
    0.0, -0.0, 1.5, -2.25, 0.1, 1e-7, 1e16, 1e300, -1e-300, 5e-324, 1.7976931348623157e308, math.pi,
    math.inf, -math.inf, math.nan, -math.nan, True, False,
])
def test_fallback_round_trips_numbers_and_bools(fallback, v):
    assert_round_trip(fallback, {"v": v, "l": [v, v], "t": {"v": v}, "aot": [{"v": v}], "in": [1, {"v": v}]})


def _nest(depth: int, leaf):
    out = leaf
    for i in range(depth):
        out = {f"k{i % 3}": out}
    return out


def _wrap_list(depth: int, leaf):
    out = leaf
    for _ in range(depth):
        out = [out]
    return out


@pytest.mark.parametrize("data", [
    {},
    {"a": {}},
    {"a": {"b": {}}},
    {"a": {"b": {"c": {"d": {"e": {}}}}}},
    {"a": [{}]},
    {"a": [{}, {}, {"x": {}}]},
    {"a": [{"b": [{"c": [{}]}]}]},
    {"a": [[1, 2], ["x", [True, [[]]]], []]},
    {"a": [[{"x": 1}], [{"y": [{"z": 2}]}]]},
    {"a": [1, {"b": {"c": [{"d": 1}]}}]},
    {"a": [{"b": {"c": 1}, "d": [{"e": {}}]}, {"b": {}}]},
    {"x": 1, "a": {"y": 2, "b": {"z": 3}}, "c": [{"w": 4, "d": {"v": 5}}]},
    {"tbl": {"list_of_tables": [{"a": 1}], "scalar": 1, "empty_list": []}},
    {"a": [{"b": {"x": 1}}, {"b": {"x": 2}}]},
    {"a": {"b": 1}, "a.b": {"c": 1}, "a\"b": {"d": [{"e": 1}]}},
    {"empty_list_of_tables": [], "list_with_empty_table": [{}], "empty_inline": [1, {}]},
    {"lvl1": {"lvl2": {"lvl3": [{"lvl4": {"lvl5": [{"lvl6": {"lvl7": {}}}]}}]}}},
    _nest(60, {"v": 1}),
    _nest(200, {}),
    {"deep_list": _wrap_list(40, 1), "deep_mixed": _wrap_list(20, {"x": [{"y": 1}]})},
], ids=range(20))
def test_fallback_round_trips_nested_structures(fallback, data):
    assert_round_trip(fallback, data)


def test_fallback_writes_tuples_and_dict_subclasses_as_lists_and_tables(fallback):
    from collections import OrderedDict
    assert_round_trip(
        fallback,
        {"t": (1, "a"), "tt": ({"a": 1}, {"b": 2}), "od": OrderedDict([("z", 1), ("a", OrderedDict(b=2))])},
        {"t": [1, "a"], "tt": [{"a": 1}, {"b": 2}], "od": {"z": 1, "a": {"b": 2}}},
    )


def test_fallback_writes_str_enum_values_as_their_text(fallback):
    from andromity.core.effort import ReasoningMode
    member = next(iter(ReasoningMode))
    assert_round_trip(fallback, {"mode": member, "t": {"m": [member]}}, {"mode": member.value, "t": {"m": [member.value]}})


CHARS = list("abcxyzABC019 _-.,:;=#[]{}()'\"\\/$`~!@%^&*+|<>?") + [
    "\n", "\r", "\t", "\b", "\f", "\x00", "\x01", "\x1b", "\x1f", "\x7f", "\x80", "\x9f", "\xa0", "\u00e9", "\u0416",
    "\u4e2d", "\u0627", "\u200d", "\u2028", "\ufeff", "\ufffd", "\U0001F600", "\U0010FFFF",
]
INTS = [0, 1, -1, 7, 2**31, -2**31, 2**63 - 1, -2**63, 10**18]
FLOATS = [0.0, -0.0, 1.5, -2.25, 1e-7, 1e16, 1e300, -1e-300, 5e-324, 1.7976931348623157e308, 0.1, math.pi,
          math.inf, -math.inf, math.nan]


def rand_str(rng, n=10, chars=CHARS):
    return "".join(rng.choice(chars) for _ in range(rng.randint(0, n)))


def rand_scalar(rng, floats=FLOATS, chars=CHARS):
    kind = rng.randrange(5)
    if kind == 0:
        return rand_str(rng, chars=chars)
    if kind == 1:
        return rng.choice(INTS + [rng.randint(-10**12, 10**12)])
    if kind == 2:
        return rng.choice(floats + [rng.uniform(-1e6, 1e6)])
    if kind == 3:
        return rng.choice([True, False])
    return rand_str(rng, 3, chars=chars)


def rand_value(rng, depth):
    if depth <= 0:
        return rand_scalar(rng)
    kind = rng.randrange(7)
    if kind <= 2:
        return rand_scalar(rng)
    if kind == 3:
        return [rand_value(rng, depth - 1) for _ in range(rng.randint(0, 3))]
    if kind == 4:
        return rand_table(rng, depth - 1)
    if kind == 5:
        return [rand_table(rng, depth - 1) for _ in range(rng.randint(1, 3))]
    return [rand_value(rng, depth - 1), rand_table(rng, depth - 1), rand_scalar(rng)]


def rand_table(rng, depth):
    return {rand_str(rng, 6): rand_value(rng, depth) for _ in range(rng.randint(0, 4))}


@pytest.mark.parametrize("seed", range(8))
def test_fallback_round_trips_random_documents(fallback, seed):
    rng = random.Random(seed)
    for _ in range(300):
        assert_round_trip(fallback, rand_table(rng, rng.randint(0, 5)))


_UNSUPPORTED = [None, b"x", bytearray(b"x"), {1, 2}, frozenset(), object(), 1j, range(3), Path("x"), type, print]
_PLACES = [
    lambda v: {"k": v},
    lambda v: {"t": {"k": v}},
    lambda v: {"t": {"deep": {"k": v}}},
    lambda v: {"l": [1, v]},
    lambda v: {"l": [[v]]},
    lambda v: {"aot": [{"k": v}]},
    lambda v: {"aot": [{"x": {"k": v}}]},
    lambda v: {"l": [{"k": v}, 1]},
    lambda v: {"l": [{"a": 1}, v]},
]


@pytest.mark.parametrize("value", _UNSUPPORTED, ids=[type(v).__name__ for v in _UNSUPPORTED])
@pytest.mark.parametrize("place", range(len(_PLACES)))
def test_fallback_rejects_values_toml_cannot_hold(fallback, value, place):
    with pytest.raises(TypeError):
        fallback.tomli_w.dumps(_PLACES[place](value))
    with pytest.raises(TypeError):
        fallback.tomli_w.dump(_PLACES[place](value), io.BytesIO())


_BAD_KEYS = [1, None, True, 1.5, (1, 2), b"k", frozenset()]
_KEY_PLACES = [
    lambda k: {k: 1},
    lambda k: {"t": {k: 1}},
    lambda k: {k: {"x": 1}},
    lambda k: {"t": {k: {}}},
    lambda k: {"aot": [{k: 1}]},
    lambda k: {k: [{"x": 1}]},
    lambda k: {"l": [1, {k: 1}]},
]


@pytest.mark.parametrize("key", _BAD_KEYS, ids=[repr(k) for k in _BAD_KEYS])
@pytest.mark.parametrize("place", range(len(_KEY_PLACES)))
def test_fallback_rejects_non_string_keys(fallback, key, place):
    with pytest.raises(TypeError):
        fallback.tomli_w.dumps(_KEY_PLACES[place](key))


class _IntMode(int, enum.Enum):
    ON = 1


class _FloatLevel(float, enum.Enum):
    HALF = 0.5


@pytest.mark.parametrize("value, number", [(_IntMode.ON, 1), (_FloatLevel.HALF, 0.5)], ids=["int-enum", "float-enum"])
def test_fallback_never_writes_number_subclasses_as_arbitrary_text(fallback, value, number):
    try:
        text = fallback.tomli_w.dumps({"v": value})
    except TypeError:
        return
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        pytest.fail(f"{value!r} was written as text that is not TOML ({e}):\n{text}")
    assert same(parsed, {"v": number})


_TZ = timezone(timedelta(hours=5, minutes=30))


@pytest.mark.parametrize("value", [
    datetime(2026, 10, 28, 15, 24, 2, tzinfo=timezone.utc),
    datetime(2026, 10, 28, 15, 24, 2, 123456, tzinfo=_TZ),
    datetime(2026, 10, 28, 15, 24, 2),
    date(2026, 10, 28),
    dtime(15, 24, 2),
], ids=["utc", "offset", "local-datetime", "date", "time"])
def test_fallback_round_trips_dates_and_times_tomllib_reads(fallback, value):
    parsed_back = tomllib.loads(tomli_w.dumps({"v": value}))["v"]
    assert parsed_back == value
    assert_round_trip(fallback, {"v": value, "t": {"v": [value]}, "aot": [{"v": value}]})


def test_fallback_can_still_save_a_config_that_holds_a_toml_datetime(fallback, tmp_path):
    conf = tmp_path / "with-date"
    write_config(conf, (
        '[default]\nprovider = "andromity"\nlast_check = 2026-10-28T15:24:02Z\n\n'
        '[[providers]]\nname = "anthropic"\ntype = "anthropic"\napi_key = "sk-ant-keep"\n'
    ))
    cm = fallback.ConfigManager(config_dir=conf)
    project = tmp_path / "project"
    project.mkdir()
    cm.set_trusted(str(project))
    again = fallback.ConfigManager(config_dir=conf)
    assert again.is_trusted(str(project))
    assert again.get("default", "last_check") == datetime(2026, 10, 28, 15, 24, 2, tzinfo=timezone.utc)
    assert again.get_api_key("anthropic") == "sk-ant-keep"


def test_fallback_rejected_value_leaves_the_saved_file_intact(fallback, tmp_path):
    conf = tmp_path / "reject"
    cm = fallback.ConfigManager(config_dir=conf)
    cm.set_api_key("customprov", "sk-custom-keep")
    before = cm.config_path.read_bytes()
    with pytest.raises(TypeError):
        cm.set("default", "broken", None)
    assert cm.config_path.read_bytes() == before
    assert sorted(p.name for p in conf.iterdir()) == ["config.toml"]


def test_fallback_rejected_value_does_not_block_later_saves(fallback, tmp_path):
    conf = tmp_path / "reject-then-save"
    cm = fallback.ConfigManager(config_dir=conf)
    with pytest.raises(TypeError):
        cm.set("default", "broken", None)
    cm.set_api_key("customprov", "sk-custom-new")
    assert fallback.ConfigManager(config_dir=conf).get_api_key("customprov") == "sk-custom-new"


# ── 2. Repairing files the old writer damaged ─────────────────────────────────────────────


def _realistic_config(project: Path) -> tuple:
    probe = ConfigManager.__new__(ConfigManager)
    key = ConfigManager._trust_key(probe, str(project))
    data = {
        "default": {
            "provider": "anthropic",
            "model": "claude-sonnet",
            "permission_mode": "safe",
            "expand_tools_while_working": True,
            "allowed_commands": ['git log --format="%H"', "dir C:\\Users\\me", "npm test", "echo {}", '{"json": 1}'],
            "temperature": 0.25,
        },
        "trusted_projects": {
            key: {"path": str(project.resolve()), "trusted_at": "2026-10-28T15:24:02+00:00"},
            "pother": {"path": "D:\\saas\\agent", "trusted_at": "2026-10-28T15:24:02+00:00"},
            "pquote": {"path": "C:\\it's \"here\"\\x", "trusted_at": "2026-10-29T01:02:03+00:00"},
        },
        "models": {
            "pinned": [
                {"id": "auto", "provider": "andromity", "name": "Andromity Auto"},
                {"id": "anthropic/claude-3.7-sonnet", "provider": "openrouter", "name": "Claude 3.7 Sonnet"},
            ],
        },
        "subagents": {
            "max_concurrent": 3,
            "roles": [{"name": "reviewer", "tools": ["read_file", "grep"], "model": "m", "limits": {"tokens": 100}}],
        },
        "providers": [
            {"name": "andromity", "type": "andromity", "base_url": "https://gateway.agenticmarket.dev/v1"},
            {"name": "anthropic", "type": "anthropic", "api_key": "sk-ant-api03-keep\\me\"x"},
            {"name": "selfhost", "type": "openai", "base_url": "http://localhost:1234/v1", "api_key": "$SELFHOST_KEY",
             "headers": {"X-Title": "Andromity", "X-Empty": ""}, "extra": {}},
        ],
    }
    return data, key


def test_repair_restores_the_old_writer_output_exactly(manager_cls, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    data, key = _realistic_config(project)
    damaged = old_fallback_dumps(data)
    assert "\"{'path': " in damaged and "\"{'id': 'auto'" in damaged
    conf = tmp_path / "old"
    path = write_config(conf, damaged)

    cm = manager_cls(config_dir=conf)
    assert cm.load_error is None
    assert same(cm._config_cache, data), cm._config_cache
    assert cm.is_trusted(str(project))
    assert cm.get_pinned_models() == data["models"]["pinned"]
    assert cm.get_api_key("anthropic") == "sk-ant-api03-keep\\me\"x"
    assert cm.get_provider_config("selfhost")["headers"] == {"X-Title": "Andromity", "X-Empty": ""}

    repaired_bytes, repaired_mtime = snapshot(path)
    assert repaired_bytes != damaged.encode("utf-8") and repaired_mtime != OLD_MTIME_NS, "the repaired file was not saved"
    assert same(tomllib.loads(repaired_bytes.decode("utf-8")), data)
    assert sorted(p.name for p in conf.iterdir()) == ["config.toml"]

    age(path)
    again = manager_cls(config_dir=conf)
    assert same(again._config_cache, data)
    assert snapshot(path) == (repaired_bytes, OLD_MTIME_NS), "a repaired file was rewritten again"


async def test_repaired_config_serves_trust_status_and_pinned_models(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    data, key = _realistic_config(project)
    cfg = load_global_config(old_fallback_dumps(data))
    status = await JsonRpcHandler().rpc_trust_status({"project_path": str(project)})
    assert status["is_trusted"] is True
    listed = {e["key"]: e for e in status["trusted_projects"]}
    assert listed[key]["path"] == str(project.resolve())
    assert listed["pquote"]["path"] == "C:\\it's \"here\"\\x"
    assert await JsonRpcHandler().rpc_config_get_pinned_models({}) == data["models"]["pinned"]
    assert cfg.get_api_key("anthropic") == "sk-ant-api03-keep\\me\"x"


SAFE_CHARS = [c for c in CHARS if c in ("\n", "\t") or not (ord(c) < 0x20 or ord(c) == 0x7F)]
FINITE_FLOATS = [f for f in FLOATS if math.isfinite(f)]
BARE = "abcdefghijklmnopqrstuvwxyz0123456789_-"


def _flat_str(rng):
    s = rand_str(rng, 12, chars=SAFE_CHARS)
    return "s" + s if s.startswith("{") else s


def _flat_value(rng, depth=2):
    kind = rng.randrange(5)
    if kind == 0:
        return _flat_str(rng)
    if kind == 1 and depth > 0:
        return [_flat_value(rng, depth - 1) for _ in range(rng.randint(0, 3))]
    value = rand_scalar(rng)
    return _flat_str(rng) if isinstance(value, str) else value


def _nested_value(rng, depth):
    kind = rng.randrange(6)
    if depth > 0 and kind == 0:
        return [_nested_value(rng, depth - 1) for _ in range(rng.randint(0, 3))]
    if depth > 0 and kind == 1:
        return _nested_table(rng, depth - 1)
    return rand_scalar(rng, floats=FINITE_FLOATS)


def _nested_table(rng, depth):
    table = {}
    for i in range(rng.randint(0, 4)):
        k = rand_str(rng, 6)
        table[k.replace("'", "q") if i == 0 else k] = _nested_value(rng, depth)
    return table


def _level2(rng):
    kind = rng.randrange(6)
    if kind == 0:
        return _nested_table(rng, rng.randint(0, 3))
    if kind == 1:
        return [_nested_table(rng, rng.randint(0, 2)) for _ in range(rng.randint(1, 3))]
    if kind == 2:
        return [_flat_value(rng, 0), _nested_table(rng, 1), _flat_value(rng, 0)]
    return _flat_value(rng)


def _old_document(rng):
    doc = {}
    for i in range(rng.randint(0, 2)):
        doc[f"root{i}"] = _flat_value(rng)
    for i in range(rng.randint(1, 4)):
        section = {"".join(rng.choice(BARE) for _ in range(rng.randint(1, 6))): _level2(rng)
                   for _ in range(rng.randint(0, 5))}
        doc[f"sec{i}"] = section
    if rng.random() < 0.6:
        doc["aot"] = [{"".join(rng.choice(BARE) for _ in range(rng.randint(1, 6))): _level2(rng)
                       for _ in range(rng.randint(0, 4))} for _ in range(rng.randint(1, 3))]
    return doc


@pytest.mark.parametrize("seed", range(4))
def test_repair_restores_random_old_writer_documents(manager_cls, tmp_path, seed):
    rng = random.Random(1000 + seed)
    for case in range(60):
        data = _old_document(rng)
        damaged = old_fallback_dumps(data)
        try:
            tomllib.loads(damaged)
        except tomllib.TOMLDecodeError as e:
            pytest.fail(f"generator produced a file the old writer could not have read back: {e}\n{damaged}")
        path = write_config(tmp_path / f"c{case}", damaged)
        cm = manager_cls(config_dir=path.parent)
        assert same(cm._config_cache, data), f"repair changed the data\nfile:\n{damaged}\ngot: {cm._config_cache!r}"
        saved = path.read_bytes()
        assert same(tomllib.loads(saved.decode("utf-8")), data), f"saved file differs\n{saved.decode('utf-8')}"
        age(path)
        manager_cls(config_dir=path.parent)
        assert snapshot(path) == (saved, OLD_MTIME_NS)


def _hostile_strings(marker: Path) -> list:
    m = str(marker)
    return [
        '{"path": "D:\\\\saas", "trusted_at": "x"}',
        "{ not python }",
        "{",
        "{}}",
        "{'}",
        "{'unterminated",
        "{'a': 1",
        "{'a': 1}}",
        "{'a': 1} && rm -rf ~",
        "{'a': 1} ",
        " {'a': 1}",
        "{'a': 1}\n",
        "{'a': None}",
        "{'a': [None]}",
        "{'a': b'x'}",
        "{'a': {1, 2}}",
        "{'a': 1j}",
        "{'a': (1, 2)}",
        "{'a': {1: 'x'}}",
        "{'a': Ellipsis}",
        "{'a': ...}",
        "{'a': 'x' * 10}",
        "{'a': -'x'}",
        "{'a': inf}",
        f"{{'a': __import__('pathlib').Path(r'{m}').write_text('x')}}",
        f"{{'a': open(r'{m}', 'w').write('x')}}",
        f"{{'a': exec(\"open(r'{m}', 'w')\")}}",
        "{'a': [x for x in __import__('os').listdir('.')]}",
        "{'a': globals()}",
        "{'a': ().__class__.__bases__[0].__subclasses__()}",
        "{'a': (lambda: 0)()}",
        "{'a': '" + "x" * 20000 + "'}",
        "{'a': " * 2500 + "1" + "}" * 2500,
        "{'a': " * 2300 + "1" + "}" * 2300,
        "{'a': " + "[" * 150 + "]" * 150 + "}",
        "{'a': " * 20 + "1" + "}" * 20,
        "{'a': " + "9" * 5000 + "}",
        "C:\\Users\\{'x'}",
        "git log --format={'a': 1}",
    ]


def test_repair_leaves_strings_that_are_not_python_tables_exactly_as_written(manager_cls, tmp_path):
    marker = tmp_path / "pwned.txt"
    hostile = _hostile_strings(marker)
    data = {
        "default": {"provider": "anthropic", **{f"h{i}": s for i, s in enumerate(hostile)}},
        "trusted_projects": {f"p{i}": s for i, s in enumerate(hostile)},
        "models": {"pinned": hostile},
        "providers": [
            {"name": "anthropic", "type": "anthropic", "api_key": "sk-ant-keep", "notes": hostile},
            {"name": "groq", "type": "groq", "api_key": "gsk-keep", **{f"h{i}": s for i, s in enumerate(hostile)}},
        ],
    }
    path = write_config(tmp_path / "hostile", tomli_w.dumps(data))
    original = snapshot(path)

    started = time.perf_counter()
    cm = manager_cls(config_dir=path.parent)
    elapsed = time.perf_counter() - started

    assert not marker.exists(), "loading the config ran code from it"
    assert elapsed < 10, f"loading hostile text took {elapsed:.1f}s"
    for section in ("default", "trusted_projects", "models"):
        for k, v in data[section].items():
            assert cm._config_cache[section][k] == v, f"{section}.{k} changed"
    assert cm._config_cache["providers"] == data["providers"]
    assert cm.get_api_key("anthropic") == "sk-ant-keep" and cm.get_api_key("groq") == "gsk-keep"
    assert snapshot(path) == original, "nothing was repaired, yet the file was rewritten"


def test_repair_converts_only_python_table_text_next_to_hostile_text(manager_cls, tmp_path):
    marker = tmp_path / "pwned.txt"
    hostile = _hostile_strings(marker)
    data = {
        "trusted_projects": {"pgood": "{'path': 'D:\\\\saas\\\\agent', 'trusted_at': '2026-10-28T15:24:02+00:00'}",
                             **{f"p{i}": s for i, s in enumerate(hostile)}},
        "models": {"pinned": ["{'id': 'auto', 'provider': 'andromity', 'name': 'Andromity Auto'}", *hostile, "{}"]},
        "providers": [{"name": "anthropic", "type": "anthropic", "api_key": "sk-ant-keep"}],
    }
    path = write_config(tmp_path / "mixed", tomli_w.dumps(data))
    cm = manager_cls(config_dir=path.parent)
    assert not marker.exists()
    assert cm._config_cache["trusted_projects"]["pgood"] == {"path": "D:\\saas\\agent",
                                                             "trusted_at": "2026-10-28T15:24:02+00:00"}
    for i, s in enumerate(hostile):
        assert cm._config_cache["trusted_projects"][f"p{i}"] == s
    assert cm._config_cache["models"]["pinned"] == [
        {"id": "auto", "provider": "andromity", "name": "Andromity Auto"}, *hostile, {}]
    reloaded = tomllib.loads(path.read_text(encoding="utf-8"))
    assert reloaded["trusted_projects"]["pgood"]["path"] == "D:\\saas\\agent"
    assert reloaded["models"]["pinned"][1:-1] == hostile
    assert manager_cls(config_dir=path.parent).get_api_key("anthropic") == "sk-ant-keep"


@pytest.mark.parametrize("literal", ["0x" + "f" * 4000, "0b" + "1" * 15000, "0o" + "7" * 5000],
                         ids=["hex", "binary", "octal"])
def test_repair_of_huge_integers_does_not_break_later_saves(manager_cls, tmp_path, literal):
    huge = "{'id': 'auto', 'provider': 'andromity', 'n': " + literal + "}"
    assert len(huge) <= 16384
    data = {
        "default": {"provider": "andromity"},
        "models": {"pinned": [huge]},
        "providers": [{"name": "anthropic", "type": "anthropic", "api_key": "sk-ant-keep"}],
    }
    path = write_config(tmp_path / "huge", tomli_w.dumps(data))
    cm = manager_cls(config_dir=path.parent)
    cm.set_api_key("customprov", "sk-custom-new")
    again = manager_cls(config_dir=path.parent)
    assert again.get_api_key("anthropic") == "sk-ant-keep"
    assert again.get_api_key("customprov") == "sk-custom-new"


# ── 3. Readers of an unrepairable config ──────────────────────────────────────────────────


DAMAGED = (
    'providers = ["{\'name\': \'anthropic\', \'api_key\': None}", 7, true, ["x"], '
    '{ name = "anthropic", type = "anthropic", api_key = "sk-ant-keep" }]\n\n'
    '[default]\nprovider = "andromity"\n\n'
    '[trusted_projects]\n'
    'pbad1 = "{\'path\': None, \'trusted_at\': None}"\n'
    'pbad2 = 5\n'
    'pbad3 = ["a", "b"]\n'
    'pbad4 = "{\\"path\\": \\"C:/json\\"}"\n'
    'pgood = { path = "C:/good", trusted_at = "2026-10-28T15:24:02+00:00" }\n\n'
    '[models]\n'
    'pinned = ["{\'id\': \'x\', \'provider\': None}", 5, "junk", ["nested"], '
    '{ id = "auto", provider = "andromity", name = "Andromity Auto" }]\n'
)


def test_damaged_config_readers_skip_entries_that_are_not_tables(manager_cls, tmp_path):
    path = write_config(tmp_path / "damaged", DAMAGED)
    cm = manager_cls(config_dir=path.parent)
    assert cm.load_error is None
    assert cm.get_pinned_models() == [{"id": "auto", "provider": "andromity", "name": "Andromity Auto"}]
    assert cm.get_provider_config("anthropic")["api_key"] == "sk-ant-keep"
    assert cm.get_provider_config("missing") is None
    assert cm.get_api_key("anthropic") == "sk-ant-keep"
    assert cm.toggle_pinned_model("m1", "groq", "M1")[-1] == {"id": "m1", "provider": "groq", "name": "M1"}


@pytest.mark.parametrize("section", [
    'models = "junk"', "models = 5", "models = []", 'models = { pinned = "junk" }', "models = { pinned = 5 }",
    "models = { pinned = { a = 1 } }", 'providers = "junk"', "providers = 5", "providers = { a = { name = 'a' } }",
    'providers = ["a", "b"]', "providers = [[1]]",
])
def test_pinned_models_and_provider_lookup_survive_wrong_section_types(manager_cls, tmp_path, section):
    path = write_config(tmp_path / "wrong", section + "\n")
    cm = manager_cls(config_dir=path.parent)
    assert all(isinstance(m, dict) for m in cm.get_pinned_models())
    assert cm.get_provider_config("a") is None
    assert cm.get_provider_config("anthropic") is None


async def test_trust_status_lists_only_table_entries(tmp_path):
    load_global_config(DAMAGED)
    status = await JsonRpcHandler().rpc_trust_status({"project_path": str(tmp_path)})
    assert status["is_trusted"] is False
    assert status["trusted_projects"] == [
        {"key": "pgood", "path": "C:/good", "trusted_at": "2026-10-28T15:24:02+00:00"}]


@pytest.mark.parametrize("trusted", [
    "5", "true", "1.5", '"text"', '["a", 1]', "[]", '{ pX = "junk" }', "{ pX = 5 }", "{ pX = [] }",
    '{ pX = { path = 5, trusted_at = [] } }',
])
async def test_trust_status_never_raises_on_damaged_trusted_projects(tmp_path, trusted):
    load_global_config(f"trusted_projects = {trusted}\n")
    status = await JsonRpcHandler().rpc_trust_status({"project_path": str(tmp_path)})
    assert status["is_trusted"] is False
    assert all(isinstance(e["path"], str) and isinstance(e["trusted_at"], str) for e in status["trusted_projects"])


@pytest.mark.parametrize("template", [
    '[trusted_projects]\n{key} = "{{\'path\': None}}"\n',
    '[trusted_projects]\n{key} = 1\n',
    'trusted_projects = "stale {key}"\n',
], ids=["unrepairable-entry", "number-entry", "string-section"])
async def test_trust_status_does_not_trust_a_folder_through_an_entry_it_skips(tmp_path, template):
    project = tmp_path / "project"
    project.mkdir()
    key = load_global_config("")._trust_key(str(project))
    damaged = template.format(key=key)
    load_global_config(damaged)
    status = await JsonRpcHandler().rpc_trust_status({"project_path": str(project)})
    listed = any(e["key"] == key for e in status["trusted_projects"])
    assert status["is_trusted"] == listed, (
        f"is_trusted={status['is_trusted']} but the folder is listed={listed} for:\n{damaged}")


@pytest.mark.parametrize("trusted", ["5", '"text"', '["a", 1]'])
async def test_trust_set_works_after_trusted_projects_was_damaged(tmp_path, trusted):
    project = tmp_path / "project"
    project.mkdir()
    load_global_config(f'trusted_projects = {trusted}\n[[providers]]\nname = "anthropic"\napi_key = "sk-ant-keep"\n')
    await JsonRpcHandler().rpc_trust_set({"project_path": str(project)})
    status = await JsonRpcHandler().rpc_trust_status({"project_path": str(project)})
    assert status["is_trusted"] is True
    assert config_module.config.get_api_key("anthropic") == "sk-ant-keep"


_LIST_DAMAGE = {
    "pinned-junk": '[models]\npinned = ["junk", 5, { id = "auto", provider = "andromity", name = "A" }]\n',
    "trusted-junk": '[trusted_projects]\npx = "junk"\n',
    "models-string": 'models = "junk"\n',
    "providers-non-table-entries": (
        'providers = ["junk", 7, { name = "andromity", type = "andromity", '
        'base_url = "https://gateway.agenticmarket.dev/v1" }]\n'),
    "providers-string": 'providers = "junk"\n',
    "providers-table": 'providers = { andromity = { name = "andromity", type = "andromity" } }\n',
}


@pytest.mark.parametrize("damage", list(_LIST_DAMAGE), ids=list(_LIST_DAMAGE))
async def test_model_list_still_lists_models_with_a_damaged_config(monkeypatch, damage):
    monkeypatch.setattr(rpc, "get_cached_live_models", lambda provider=None: [])
    monkeypatch.setattr(rpc, "fetch_live_models_sync", lambda *args, **kwargs: [])

    load_global_config('[default]\nprovider = "andromity"\n')
    baseline = await JsonRpcHandler().rpc_config_list_models({"provider": "andromity", "discover": False})
    assert any(m["id"] == "auto" for m in baseline)

    load_global_config(_LIST_DAMAGE[damage])
    listed = await JsonRpcHandler().rpc_config_list_models({"provider": "andromity", "discover": False})
    assert any(m["id"] == "auto" for m in listed), f"the model list came back empty: {listed!r}"
    every = await JsonRpcHandler().rpc_config_list_models({"discover": False})
    assert any(m["provider"] == "andromity" for m in every)


# ── 4. Files tomli-w (or the new fallback) wrote are left alone ────────────────────────────


def _clean_config(project: Path) -> dict:
    data, _ = _realistic_config(project)
    data["default"]["lookalikes"] = [
        '{"a": 1}', "{ x }", "{'a': None}", "{'a': __import__('os')}", "{'unterminated", "C:\\{'a'}",
        "{'a': 1} trailing", "{", "}", "{{}}", "{'a': 1}}", "",
    ]
    data["default"]["json_settings"] = '{"theme": "dark", "nested": {"a": [1, 2]}}'
    data["default"]["empty"] = {}
    data["default"]["floats"] = [math.inf, -math.inf, -0.0, 1e-7]
    return data


@pytest.mark.parametrize("writer", ["tomli_w", "fallback"])
def test_a_normally_written_config_loads_unchanged_and_is_not_rewritten(manager_cls, tmp_path, request, writer):
    project = tmp_path / "project"
    project.mkdir()
    data = _clean_config(project)
    dumps = tomli_w.dumps if writer == "tomli_w" else request.getfixturevalue("fallback").tomli_w.dumps
    path = write_config(tmp_path / "clean", dumps(data))
    before = snapshot(path)

    cm = manager_cls(config_dir=path.parent)
    assert cm.load_error is None
    assert same(cm._config_cache, data)
    assert snapshot(path) == before, "a config with nothing to repair was rewritten"
    assert sorted(p.name for p in path.parent.iterdir()) == ["config.toml"]
    assert cm.is_trusted(str(project))
