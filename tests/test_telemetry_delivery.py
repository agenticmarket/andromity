import json
from unittest.mock import MagicMock, patch

from andromity import telemetry


def test_retry_preserves_event_identity_and_spools_before_network(tmp_path):
    observed = []

    def receive(request, **kwargs):
        observed.append(json.loads(request.data))
        assert (tmp_path / '.telemetry_outbox.json').exists()
        if len(observed) == 1:
            raise OSError('offline')
        return MagicMock()

    with patch.object(telemetry, 'get_config_dir', return_value=tmp_path), \
            patch.object(telemetry, '_should_send_telemetry', return_value=True), \
            patch('urllib.request.urlopen', side_effect=receive), patch.object(telemetry.time, 'sleep'):
        telemetry._post(telemetry._EVENT_ENDPOINT, {'event': 'feature_use'})
    assert len(observed) == 2
    assert observed[0]['event_id'] == observed[1]['event_id']
    assert json.loads((tmp_path / '.telemetry_outbox.json').read_text()) == []


def test_failed_delivery_retained_then_opt_out_clears_it(tmp_path):
    with patch.object(telemetry, 'get_config_dir', return_value=tmp_path), \
            patch.object(telemetry, '_should_send_telemetry', return_value=True), \
            patch('urllib.request.urlopen', side_effect=OSError('offline')), patch.object(telemetry.time, 'sleep'):
        telemetry._post(telemetry._EVENT_ENDPOINT, {'event': 'task_started'})
    assert len(json.loads((tmp_path / '.telemetry_outbox.json').read_text())) == 1
    with patch.object(telemetry, 'get_config_dir', return_value=tmp_path), \
            patch.object(telemetry, '_should_send_telemetry', return_value=False), \
            patch('urllib.request.urlopen') as network:
        telemetry._post(telemetry._EVENT_ENDPOINT, {})
        network.assert_not_called()
    assert not (tmp_path / '.telemetry_outbox.json').exists()


def test_task_uuid_is_not_scrubbed_as_a_key():
    run_id = '0123456789abcdef0123456789abcdef'
    with patch.object(telemetry, '_should_send_telemetry', return_value=True), \
            patch.object(telemetry, '_get_or_create_user_id', return_value='anonymous'), \
            patch.object(telemetry.threading, 'Thread') as thread:
        telemetry.send_task_event('task_finished', 'sess-example', run_id, outcome='completed')
    payload = thread.call_args.kwargs['args'][1]
    assert payload['run_id'] == run_id
    assert payload['outcome'] == 'completed'
