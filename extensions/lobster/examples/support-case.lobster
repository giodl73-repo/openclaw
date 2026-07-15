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
      --wait-timeout-ms 60000

  - id: resolve_case
    pipeline: >
      openclaw.skill --skill resolve-case
      --task "Resolve case ${case_id} after customer verification"
      --task-name resolve_case --step-id resolve-case
      --wait-timeout-ms 60000
