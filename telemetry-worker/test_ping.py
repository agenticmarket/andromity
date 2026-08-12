import urllib.request
import urllib.error
import json

data = json.dumps({'event': 'first_launch', 'os': 'windows', 'version': '0.1.1'}).encode()
req = urllib.request.Request(
    'https://andromity-telemetry.shekharpachlore99.workers.dev/ping', 
    data=data, 
    headers={'Content-Type': 'application/json', 'User-Agent': 'test'}, 
    method='POST'
)

try: 
    print(urllib.request.urlopen(req).read())
except urllib.error.HTTPError as e: 
    print(e.read())
