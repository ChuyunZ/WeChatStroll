# #107 dependency audit — 2026-10-11

Read-only `npm.cmd audit --json --package-lock-only` in both legacy wrapper
directories reports **6 affected packages: 5 high, 1 moderate**. These are package
entries, not six independent vulnerabilities. No install, override, upgrade or
`audit fix` was performed. Versions below come from both wrapper lockfiles;
`mapProvider` has the same SDK subtree. Runtime tracing used the matching versions
in the root installation; wrapper dependencies were not installed locally.

| Package | Locked version | Relationship in wrappers | Finding |
| --- | --- | --- | --- |
| `wx-server-sdk` | 4.0.2 | Direct, production | High inherited from node-sdk |
| `@cloudbase/node-sdk` | 3.17.2 | Direct and wx SDK dependency, production | High inherited from database and nested axios |
| `@cloudbase/database` | 1.4.3 | Transitive production | High inherited from lodash.set/unset |
| `axios` | 0.27.2 | Nested under node-sdk, production | High; SSRF/credential leakage, prototype gadgets, proxy bypass and resource exhaustion advisories below |
| `lodash.set` | 4.3.2 | Transitive production | High prototype pollution, GHSA-p6mc-m468-83gw (CVE-2020-8203) |
| `lodash.unset` | 4.5.2 | Transitive production | Moderate prototype pollution, GHSA-xxjr-mmjv-4gpg and GHSA-f23m-r3pf-42rh |

The gateway's **direct axios is 1.20.0**, separate from the vulnerable 0.27.2 copy.
Updating its direct axios would not update the SDK's pinned nested copy. Root
devDependencies do not make the independent cloud-function dependencies dev-only.

## Reachability and release decision

- Wrappers use `wx-server-sdk` for initialization and `getWXContext`, then
  `@cloudbase/node-sdk.callFunction` with the fixed target `mapProvider`.
  `dist/functions/index.js` serializes event business data as `request_data`,
  then uses `utils/tcbapirequester` / `request` / `request-core`, not nested axios
  as the normal function-invocation transport. Events do not supply SDK options,
  proxy headers or target URLs. This does not prove all SDK initialization paths
  are unreachable.
- The old axios is imported in SDK `cloudbase.js` (`requestClient`, unused by
  these functions) and `utils/metadata.js`. Cloud environment detection and
  credential fallback can use it for the fixed metadata host and SDK role name.
  Therefore it can execute in production depending on runtime credentials; it is
  not safe to dismiss it as dead code. No path from a map event to an arbitrary
  axios URL/config or proxy setting was found. Browser XSRF/cookie paths are not
  used by this Node runtime. Prototype gadget advisories additionally require
  pollution; no such source was found on the audited map path. Metadata/proxy
  behavior must still be checked in the deployed runtime before sign-off.
- Database `dist/commonjs/realtime/virtual-websocket-client.js` applies the
  vulnerable set/unset functions to realtime change field paths. Neither gateway
  nor wrappers call database `watch()`. Gateway quota/QPS operations use fixed
  collections, validated/generated document IDs and transactional get/set.
  No request-controlled realtime field path reaches those functions in this
  audited scope. Other AI/Track/functions were not audited or changed here.

**No directly exploitable event-to-vulnerable-operation path was established in
this map review. The six advisories remain unresolved, not accepted as safe.**
Dependency security sign-off is an outstanding release gate. If runtime review
finds attacker-controlled metadata/proxy configuration, prototype pollution, or
realtime paths entering these functions, treat that as a **Release Blocker** and
fix before enabling planning. No risk acceptance is made on the user's behalf.

## Remediation without a blind SDK upgrade

1. Ask the SDK maintainer for a release replacing the obsolete standalone lodash
   methods and updating pinned axios. `lodash.set` has no patched standalone
   version in its advisory. A patched monolithic lodash version is not a drop-in
   package override: it exports a different interface.
2. The audit's proposed node-sdk **3.0.0** and wx SDK **2.5.3** are downgrades from
   the installed versions, despite being labeled fixes. They can regress
   transport/identity/transaction behavior. Do not apply them automatically.
   `lodash.unset`'s `fixAvailable: true` does not establish a compatible fix for
   the database SDK's exact 4.5.2 pin or address lodash.set.
3. The reported old-axios affected ranges extend through `<0.34.0`. A targeted
   SDK dependency update/override to a maintainer-supported patched version is
   a candidate, **not a verified safe minor upgrade** (0.x minor releases may
   break compatibility). Validate metadata credential handling, proxy/redirect
   behavior, invocation timeouts and quota/QPS transactions in an isolated
   environment, rerun audit and contract tests, then request upgrade approval.
4. There is no proven safe, drop-in small-version change to claim from this
   audit alone. Track SDK remediation separately; keep realtime watch and
   arbitrary SDK transport options out of map entrypoints. Any temporary
   exception needs an explicit owner, expiry and runtime reachability evidence.

## Audit advisory inventory

The following inventory is extracted from the read-only npm advisory response.
Links identify each finding precisely; affected ranges refer to the packages
reported by npm, not to a promise that every advisory is reachable here.

| Package | Advisory | Reported affected range |
| --- | --- | --- |
| axios | [Axios Cross-Site Request Forgery Vulnerability](https://github.com/advisories/GHSA-wf5p-g6vw-rhxx) | >=0.8.1 <0.28.0 |
| axios | [axios Requests Vulnerable To Possible SSRF and Credential Leakage via Absolute URL](https://github.com/advisories/GHSA-jr5f-v2jv-69x6) | <0.30.0 |
| axios | [Axios has a NO_PROXY Hostname Normalization Bypass that Leads to SSRF](https://github.com/advisories/GHSA-3p68-rc4w-qgx5) | <0.31.0 |
| axios | [Axios: Authentication Bypass via Prototype Pollution Gadget in `validateStatus` Merge Strategy](https://github.com/advisories/GHSA-w9j2-pvgh-6h63) | <=0.31.0 |
| axios | [Axios: Incomplete Fix for CVE-2025-62718 — NO_PROXY Protection Bypassed via RFC 1122 Loopback Subnet (127.0.0.0/8) in Axios 1.15.0](https://github.com/advisories/GHSA-pmwg-cvhr-8vh7) | <=0.31.0 |
| axios | [Axios: Null Byte Injection via Reverse-Encoding in AxiosURLSearchParams](https://github.com/advisories/GHSA-xhjh-pmcv-23jw) | <=0.31.0 |
| axios | [Axios: no_proxy bypass via IP alias allows SSRF](https://github.com/advisories/GHSA-m7pr-hjqh-92cm) | <=0.31.0 |
| axios | [Axios' HTTP adapter-streamed uploads bypass maxBodyLength when maxRedirects: 0](https://github.com/advisories/GHSA-5c9x-8gcm-mpgx) | <=0.31.0 |
| axios | [Axios: HTTP adapter streamed responses bypass maxContentLength](https://github.com/advisories/GHSA-vf2m-468p-8v99) | <=0.31.0 |
| axios | [Axios: Prototype Pollution Gadgets - Response Tampering, Data Exfiltration, and Request Hijacking](https://github.com/advisories/GHSA-pf86-5x62-jrwf) | <=0.31.0 |
| axios | [Axios: Header Injection via Prototype Pollution](https://github.com/advisories/GHSA-6chq-wfr3-2hj9) | <=0.31.0 |
| axios | [Axios: XSRF Token Cross-Origin Leakage via Prototype Pollution Gadget in `withXSRFToken` Boolean Coercion](https://github.com/advisories/GHSA-xx6v-rp6x-q39c) | <=0.31.0 |
| axios | [Axios is Vulnerable to Denial of Service via __proto__ Key in mergeConfig](https://github.com/advisories/GHSA-43fc-jf86-j433) | <=0.30.2 |
| axios | [Axios has Unrestricted Cloud Metadata Exfiltration via Header Injection Chain](https://github.com/advisories/GHSA-fvcv-3m26-pcqx) | <0.31.0 |
| axios | [Axios: unbounded recursion in toFormData causes DoS via deeply nested request data](https://github.com/advisories/GHSA-62hf-57xw-28j9) | <=0.31.0 |
| axios | [Axios: Regular Expression Denial of Service (ReDoS) via Cookie Name Injection](https://github.com/advisories/GHSA-hfxv-24rg-xrqf) | <=0.31.1 |
| axios | [Axios: Proxy-Authorization Credential Leak to Origin Server Across HTTP-to-HTTPS Redirect in Axios Node.js HTTP Adapter](https://github.com/advisories/GHSA-p92q-9vqr-4j8v) | <=0.31.1 |
| axios | [Axios: Proxy-Authorization header leaks to redirect target when proxy is re-evaluated to direct connection](https://github.com/advisories/GHSA-j5f8-grm9-p9fc) | <=0.31.1 |
| axios | [axios Vulnerable to Credential Theft and Response Hijacking via Prototype Pollution Gadget in Config Merge](https://github.com/advisories/GHSA-3g43-6gmg-66jw) | >=0.19.0 <0.31.1 |
| axios | [axios has DoS & Header Injection via Prototype Pollution Read-Side Gadgets in axios merge functions](https://github.com/advisories/GHSA-898c-q2cr-xwhg) | <=0.31.1 |
| axios | [axios's shouldBypassProxy does not recognize IPv4-mapped IPv6 addresses, allowing NO_PROXY bypass (incomplete fix for CVE-2025-62718)](https://github.com/advisories/GHSA-pjwm-pj3p-43mv) | <=0.31.1 |
| axios | [Axios: Prototype pollution gadgets can alter axios request construction](https://github.com/advisories/GHSA-mmx7-hfxf-jppx) | <0.33.0 |
| axios | [Axios: Nested axios option objects can consume polluted prototype values](https://github.com/advisories/GHSA-7q8q-rj6j-mhjq) | >=0.8.0 <0.33.0 |
| axios | [Axios: Prototype-Pollution Gadget in the Default Instance Allows Inherited Object.prototype.method to Override HTTP Method](https://github.com/advisories/GHSA-9fr6-4gfg-395g) | >=0.27.2 <0.34.0 |
| lodash.set | [Prototype Pollution in lodash](https://github.com/advisories/GHSA-p6mc-m468-83gw) | >=3.7.0 <=4.3.2 |
| lodash.unset | [lodash vulnerable to Prototype Pollution via array path bypass in `_.unset` and `_.omit`](https://github.com/advisories/GHSA-f23m-r3pf-42rh) | >=4.0.0 <4.18.0 |
| lodash.unset | [Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit` functions](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) | >=4.0.0 <=4.5.2 |
