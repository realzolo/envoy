# Envoy Architecture

## Trust boundaries

Business services authenticate with service-scoped credentials and know nothing about the active email provider. Their
request and callback contracts contain no provider-specific fields. Provider SDKs and native payloads are confined to
modules under `src/modules/providers`.

Business services own content definitions, localization, and rendering. They submit the final subject, HTML, and/or
plain text plus a stable message category. Envoy persists only the resulting delivery payload for operations and
retention; it has no business content registry, versioning model, or rendering engine.

The core domain imports only `CanonicalMessage`, `CanonicalEvent`, and `CanonicalProviderError`. A provider module
exposes a descriptor, capabilities, and narrow ports for sending, webhook processing, identity management, inbound mail,
suppression synchronization, reconciliation, and health checks.

## Persistence and queues

PostgreSQL is authoritative. Accepting a message writes the message, one delivery per recipient, and outbox events in
one transaction. BullMQ job payloads contain only internal identifiers. A lost or duplicated queue job is recoverable
from PostgreSQL and cannot create an additional attempt after an accepted attempt exists.

Raw MIME, large native payloads, and attachments are written to the configured object store. The database stores
metadata and object keys. Local object storage is development-only; production should use an encrypted S3-compatible
bucket.

## Routing

The routing engine evaluates product, service, category, and destination region. It removes targets whose
provider account is disabled or unhealthy, whose identity is not verified, whose circuit is open, or whose quota or
account/identity rate limit is exhausted. It then selects the lowest priority tier and performs deterministic weighted
selection.

Every attempt stores:

- the selected policy and target;
- all eligible candidates and excluded accounts;
- the provider account and verified identity;
- a request fingerprint and provider idempotency key, when supported;
- the determinate or unknown outcome and canonical error classification.

The same visible From domain must be verified on every target used for failover.

## Failure semantics

Failover is allowed only after a provider response proves that the request was not accepted. An external message ID is a
point of no return and prevents provider switching. Network timeouts and response loss produce an `unknown` attempt; the
reconciliation worker checks the original provider before any retry.

Hard bounce, complaint, invalid recipient, and policy rejection do not trigger provider failover. Native idempotency is
a capability and is used only by providers that support it. The admin console requires an explicit duplicate-risk
acknowledgement before manually retrying an unknown delivery.

Delivery facts are independent dimensions:

- lifecycle: `queued`, `submitting`, `accepted`, `deferred`, `delivered`, `bounced`, `failed`, `unknown`, `canceled`;
- engagement: `unopened`, `opened`, `clicked`;
- compliance: `clean`, `complained`, `unsubscribed`, `suppressed`.

Event application is idempotent and timestamp-aware, so delayed events cannot overwrite newer facts.

## Provider setup

Create a provider account in the operations console, enter its public configuration and write-only credential, then test
connectivity. Credentials are never returned by the API. Rotation creates a new credential version and revokes the prior
version in one transaction.

Create a logical domain in **Domain Matrix** and select the provider accounts that should carry it. Envoy calls each
provider identity port and displays the DNS records returned by that provider. Routing targets become eligible only
after the relevant provider identity is verified.

Supported modules:

| Provider   | Webhook security                                             | Inbound mode                       |
|------------|--------------------------------------------------------------|------------------------------------|
| Resend     | Svix signature and replay window                             | Webhook plus API fetch             |
| Amazon SES | SNS certificate signature and expected TopicArn              | Receipt Rule plus S3/SNS reference |
| SendGrid   | ECDSA signed event webhook; token-protected Inbound Parse    | Multipart Inbound Parse            |
| Mailgun    | Timestamp, token, and HMAC signature                         | Routes multipart payload           |
| Postmark   | Basic Auth, opaque endpoint, IP allowlist, schema validation | Inbound webhook                    |

Postmark does not advertise a nonexistent HMAC mechanism.

### Provider configuration shapes

The console separates public configuration, write-only provider credentials, and write-only webhook security. These JSON
shapes are versioned and validated before storage.

| Provider   | Public configuration                                                                                           | Encrypted credential                                                                                   | Webhook security                                             |
|------------|----------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|
| Resend     | `{"apiBase":"https://api.resend.com"}`                                                                         | `{"apiKey":"re_..."}`                                                                                  | `{"signingSecret":"whsec_..."}`                              |
| Amazon SES | `{"region":"us-east-1","configurationSet":"envoy","roleArn":"arn:aws:iam::...:role/envoy","externalId":"..."}` | `{}` for workload identity, or encrypted `accessKeyId`, `secretAccessKey`, and optional `sessionToken` | Expected SNS Topic ARN in its dedicated field                |
| SendGrid   | `{"apiBase":"https://api.sendgrid.com"}`                                                                       | `{"apiKey":"SG....","webhookPublicKey":"..."}`                                                         | Optional `publicKey` override and `inboundToken`             |
| Mailgun    | `{"region":"us","sendingDomain":"mg.example.com"}`                                                             | `{"apiKey":"key-...","webhookSigningKey":"..."}`                                                       | `{}`                                                         |
| Postmark   | `{"apiBase":"https://api.postmarkapp.com","messageStream":"outbound"}`                                         | `{"serverToken":"...","webhookUsername":"...","webhookPassword":"..."}`                                | Optional Basic Auth override plus the dedicated IP allowlist |

After account creation, copy the opaque endpoint displayed under **Callbacks** into the provider console. Never place a
provider credential in that URL. Envoy redacts authorization headers before raw event persistence and reconstructs the
asynchronous verification context from encrypted configuration.

### DNS and identity workflow

1. Create the provider account and run **Test connection**.
2. Create a logical sending domain and select every provider that may carry it.
3. Publish the returned DKIM, SPF, return-path, and ownership records at the authoritative DNS provider.
4. Use **Refresh DNS** until each intended identity is verified.
5. Create sender profiles and routing targets only for the logical domain. Runtime routing rejects disabled domains,
   mismatched account/identity pairs, and unverified identities.

SES inbound requires a Receipt Rule that stores MIME in S3 and publishes the receipt event to the configured SNS topic.
SendGrid Inbound Parse and Mailgun Routes post multipart payloads to the opaque endpoint. Resend posts the receive event
and Envoy fetches the message through the provider API. Postmark posts the full inbound payload.

## Inbound safety

Inbound routes match provider endpoint, recipient domain, and local-part pattern. Raw MIME and attachments are
size-limited, stored outside PostgreSQL, scanned through ClamAV in production, and HTML is sanitized before persistence.
The business callback receives only canonical metadata and Envoy identifiers.

## Suppression policy

- Hard bounce and invalid mailbox may create a global suppression.
- Complaint creates a permanent global suppression.
- Unsubscribe is scoped to a product or list.
- A single soft bounce never creates a permanent suppression. Repeated soft bounces cross a threshold and create an
  expiring suppression.

## Credential security

Every provider or callback secret is encrypted with an independent random data encryption key using AES-256-GCM. The
resource ID and credential version are authenticated as AAD. The data key is wrapped by `ENVOY_KEK_BASE64`; production
deployments should source that root trust from a KMS-backed secret injection mechanism. Workers decrypt credentials only
immediately before a provider call. Secrets never enter logs, queues, or caches.

`ENVOY_KEK_VERSION` labels new envelopes. During root-key rotation, `ENVOY_KEK_KEYRING_JSON` supplies prior
version-to-key mappings until those envelopes are rewrapped; an unavailable version fails closed.

For Amazon SES, `roleArn` and optional `externalId` enable workload identity through AssumeRole. Static access keys are
supported only as an encrypted fallback.

## Canonical callbacks

Callbacks contain Envoy message, delivery, inbound, product, category, and recipient identifiers. They never expose
provider account IDs, native event names, or provider payloads. Requests are signed as
`HMAC-SHA256(timestamp + "." + body)` and retried with exponential backoff. Exhausted callbacks enter the dead-letter
state and can be replayed from the console.

Consumers should reject stale timestamps, compare signatures in constant time, and deduplicate on the stable
`x-envoy-id` header. Callback delivery is at least once.

## Service API

The versioned service API is discovered at `/api/v1` and described by `/api/v1/openapi.json`. A service credential is
scoped to one product and service. Ownership filters are applied to every message, delivery, event, inbound message,
and suppression operation.

Message acceptance is asynchronous and idempotent. A successful request commits the message, one delivery per
recipient, and durable outbox work before returning `202`. The API also exposes cursor-paginated message, delivery,
event, and inbound collections; logical sender discovery; product suppression management; pre-provider cancellation;
and controlled retry. An `unknown` delivery can only be retried when the caller explicitly acknowledges duplicate risk.

## Operational recovery

- A determinate provider rejection may use the next eligible account. Authentication, quota, rate, health, verified
  identity, policy priority, target priority, and weight are evaluated before every attempt.
- A transport ambiguity becomes `unknown` and is reconciled against the original provider. Envoy never performs
  automatic cross-provider failover from an unknown outcome.
- Repeated retryable provider, network, or rate-limit failures open the target circuit. An expired circuit is probed and
  closes after a successful acceptance.
- Exhausted provider quota or temporary lack of a healthy route moves the delivery to `deferred` and schedules a durable
  re-evaluation.
- Raw provider events and callback deliveries are replayable from the console. Manual retry of an unknown delivery
  requires explicit duplicate-risk acknowledgement and is always audited.
