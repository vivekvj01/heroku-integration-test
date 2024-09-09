
#!/usr/bin/env bash

set -euo pipefail

# Using Python here since the GNU and BSD versions of the 'base64' command have differing
# output wrapping behaviour/arguments, which makes writing something portable a pain.
function base64_encode() {
  python3 -c "import base64, sys; print(base64.b64encode(sys.stdin.buffer.read()).decode('ascii'))"
}

ORG_DOMAIN=${1?"Requires ORG_DOMAIN"}
ACCESS_TOKEN=${2?"Requires ACCESS_TOKEN"}
ORG_ID=${3:-00Dxx0000000000EAA}
USER_ID=${4:-005xx0000000000AAA}

REQUEST_ID="`echo ${ORG_ID}`-7c566091-7af3-4e87-8865-4e014444c298-2024-09-03T20:56:27.608444Z"

CLIENT_CONTEXT=$(base64_encode cat <<EOF
{
  "requestId": "${REQUEST_ID}",
  "accessToken": "${ACCESS_TOKEN}",
  "apiVersion": "62.0",
  "namespace": "",
  "orgId": "${ORG_ID}",
  "orgDomainUrl": "${ORG_DOMAIN}",
  "userContext": {
    "userId": "${USER_ID}",
    "username": "admin@mycompany.com"
  }
}
EOF
)

CMD="curl -v \
  http://127.0.0.1:3000/accounts \
  -X GET \
  -H \"Content-Type: application/json\" \
  -H \"x-request-id: ${REQUEST_ID}\" \
  -H \"x-client-context: `echo ${CLIENT_CONTEXT}`\""
echo $CMD
eval $CMD
