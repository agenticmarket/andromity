"""Error cards are chosen by the HTTP status in the message, not by digits that happen to appear in IDs or timestamps."""
import pytest

from andromity.core.provider import classify_error_info, has_status_code


@pytest.mark.parametrize("text,code,found", [
    ("HTTP 404 Not Found", "404", True),
    ("Error code: 429 - rate", "429", True),
    ("status=503", "503", True),
    ("(500)", "500", True),
    ("req_14045001", "404", False),
    ("reset at 1793027664044", "404", False),
    ("took 5002ms", "500", False),
    ("", "404", False),
])
def test_has_status_code_matches_whole_numbers(text, code, found):
    assert has_status_code(text, code) is found


def test_rate_limit_with_digits_in_its_reset_time_stays_a_rate_limit():
    err = Exception('RateLimitError: {"message":"Rate limit exceeded","X-RateLimit-Reset":"1793027664044","request_id":"req_5004011"}')
    assert classify_error_info(err, provider="openrouter", model="m")["type"] == "rate_limit"


@pytest.mark.parametrize("text,expected", [
    ("Error code: 404 - model gpt-x not found", "model_not_found"),
    ("upstream returned 503 Service Unavailable", "provider_unavailable"),
    ("HTTP 401: invalid credentials", "auth_error"),
])
def test_real_status_codes_still_classify(text, expected):
    assert classify_error_info(Exception(text), provider="openrouter", model="m")["type"] == expected


def test_numbers_inside_ids_do_not_turn_an_error_into_an_outage_or_auth_failure():
    err = Exception("Tool call failed: request req_74013500 returned an empty body")
    assert classify_error_info(err, provider="openrouter", model="m")["type"] not in ("provider_unavailable", "auth_error", "model_not_found")
