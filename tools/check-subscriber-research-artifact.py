#!/usr/bin/env python3
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
artifact = json.loads(path.read_text())
assert artifact["survey"]["invited"] >= artifact["survey"]["responses"] >= 0
if artifact["survey"]["responses"]:
    expected = artifact["survey"]["responses"] / artifact["survey"]["invited"]
    assert abs(artifact["survey"]["response_rate"] - expected) < 1e-9
else:
    assert artifact["survey"]["response_rate"] is None
assert artifact["privacy"]["subscriber_addresses_in_artifact"] == 0
assert artifact["privacy"]["individual_responses_published"] is False
assert artifact["privacy"]["analytics_profile_created"] is False
assert artifact["sampling_frame_request"]["public_artifact_contains_addresses"] is False
serialized = json.dumps(artifact).lower()
for forbidden in ("@gmail.", "@yahoo.", "@outlook.", "@icloud."):
    assert forbidden not in serialized
print(f"validated subscriber research artifact: {path}")
