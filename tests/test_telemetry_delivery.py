import json
from unittest.mock import MagicMock, patch

from andromity import telemetry


def _delivering(tmp_path, **network):
    return (patch.object(telemetry, 'get_config_dir', return_value=tmp_path),
            patch.object(telemetry, '_should_send_telemetry', return_value=True),
            patch.object(telemetry, '_sender', MagicMock(is_alive=lambda: True)),
            patch.object(telemetry, '_retry_at', 0.0), patch.object(telemetry, '_failures', 0),
            patch('urllib.request.urlopen', **network))


def test_retry_preserves_event_identity_and_spools_before_network(tmp_path):
    observed = []

    def receive(request, **kwargs):
        observed.append(json.loads(request.data))
        assert (tmp_path / '.telemetry_outbox.json').exists()
        if len(observed) == 1:
            raise OSError('offline')
        return MagicMock()

    patches = _delivering(tmp_path, side_effect=receive)
    with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
        telemetry._post(telemetry._EVENT_ENDPOINT, {'event': 'feature_use'})
        telemetry._deliver()
        telemetry._retry_at = 0.0
        telemetry._deliver()
    assert len(observed) == 2
    assert observed[0]['event_id'] == observed[1]['event_id']
    assert not (tmp_path / '.telemetry_outbox.json').exists()


def test_failed_delivery_retained_then_opt_out_clears_it(tmp_path):
    patches = _delivering(tmp_path, side_effect=OSError('offline'))
    with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
        telemetry._post(telemetry._EVENT_ENDPOINT, {'event': 'task_started'})
        telemetry._deliver()
    assert len(json.loads((tmp_path / '.telemetry_outbox.json').read_text())) == 1
    with patch.object(telemetry, 'get_config_dir', return_value=tmp_path), \
            patch.dict('os.environ', {'DO_NOT_TRACK': '1'}), \
            patch('urllib.request.urlopen') as network:
        telemetry.send_feature_used('waterfall')
        network.assert_not_called()
    assert not (tmp_path / '.telemetry_outbox.json').exists()


def test_task_uuid_is_not_scrubbed_as_a_key():
    run_id = '0123456789abcdef0123456789abcdef'
    with patch.object(telemetry, '_should_send_telemetry', return_value=True), \
            patch.object(telemetry, '_get_or_create_user_id', return_value='anonymous'), \
            patch.object(telemetry, '_post') as post:
        telemetry.send_task_event('task_finished', 'sess-example', run_id, outcome='completed')
    payload = post.call_args.args[1]
    assert payload['run_id'] == run_id
    assert payload['outcome'] == 'completed'
