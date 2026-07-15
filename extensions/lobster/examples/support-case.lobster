name: support-case
args:
  case_id:
    default: ""
steps:
  - id: verify_customer
    pipeline: >
      openclaw.skill --skill verify-customer
      --task "Verify the customer for case ${case_id}"
      --task-name verify_customer --step-id verify-customer
      --receipt-type customer.verified
      --wait-timeout-ms 60000

  - id: approve_resolution
    approval: Resolve this verified customer case?
    stdin: $verify_customer.json.receipt
    when: $verify_customer.json.receipt.type == "customer.verified"

  - id: resolve_case
    pipeline: >
      openclaw.skill --skill resolve-case
      --task "Resolve case ${case_id} using the authorization code in workflow-input.json"
      --input-name authorizationCode
      --task-name resolve_case --step-id resolve-case
      --wait-timeout-ms 60000
    stdin: $verify_customer.json.receipt.data.authorizationCode
    when: $approve_resolution.approved
