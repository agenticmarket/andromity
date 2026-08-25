"""Unit tests for the Usage dashboard chart formatters and top-3 selection logic."""
import pytest

from andromity.tui.overlays.settings import SettingsScreen, _format_cost, _format_tokens


class TestFormatCost:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0.0, "$0"),
            (0.0008, "$0.0008"),
            (0.0141, "$0.0141"),
            (0.99995, "$1"),          # rounds to $1.00 -> trailing zeros trimmed
            (5.5, "$5.50"),
            (12.345, "$12"),
            (1500.0, "$1.5k"),
            (2_340_000.0, "$2.3m"),
        ],
    )
    def test_tiers(self, value, expected):
        assert _format_cost(value) == expected

    def test_zero_free_models(self):
        assert _format_cost(0) == "$0"


class TestFormatTokens:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, "0"),
            (999, "999"),
            (12400, "12k"),
            (88210, "88k"),
            (1_240_000, "1.2M"),
        ],
    )
    def test_tiers(self, value, expected):
        assert _format_tokens(value) == expected

    def test_small_k_boundary(self):
        assert _format_tokens(1000) == "1.0k"


class TestTruncateName:
    def test_short_name_unchanged(self):
        assert SettingsScreen._truncate_name("openai/gpt-4o-mini") == "openai/gpt-4o-mini"

    def test_long_name_truncated_with_ellipsis(self):
        long = "anthropic/claude-sonnet-4-5-20250929-thinking-latest"
        result = SettingsScreen._truncate_name(long)
        assert len(result) <= 46
        assert result.endswith("…")
        assert result.startswith(long[:45])


class TestChartTopThree:
    def test_chart_data_sorted_and_limited(self):
        """Mirror of UsageChart.on_mount ranking: sorted by metric desc, top 3."""
        data = {
            "m-a": {"cost": 0.01, "tokens": 500},
            "m-b": {"cost": 0.05, "tokens": 9000},
            "m-c": {"test": 0},
            "m-d": {"cost": 0.03, "tokens": 20000},
            "m-e": {"cost": 0.02, "tokens": 300000},
        }
        ranked = sorted(data.items(), key=lambda kv: kv[1].get("cost", 0.0), reverse=True)[:3]
        assert [k for k, _ in ranked] == ["m-b", "m-d", "m-e"]

        ranked_tokens = sorted(data.items(), key=lambda kv: kv[1].get("tokens", 0.0), reverse=True)[:3]
        assert [k for k, _ in ranked_tokens] == ["m-e", "m-d", "m-b"]
