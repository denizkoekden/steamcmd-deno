# SteamCMD Deno API

This project provides a Deno-based API for querying Steam application data using
the `steam-user` npm package. It supports Redis caching, Steam account
authentication, and can be deployed across multiple platforms. The API allows
fetching detailed information about Steam apps by their `appId`, with fallback
support for anonymous queries.

## Features

- Query Steam app data using the Steam Client protocol, supporting both
  authenticated and anonymous logins.
- Resolve **private/beta branch metadata** (e.g. `development` branch buildid)
  by registering a branch password via the `X-Steam-Beta-Password` header. The
  API automatically falls back to a bundled `steamcmd` invocation for this case,
  since Steam no longer exposes private branch data via the standard PICS
  protocol since Nov 2024.
- Cache responses in Redis to improve performance.
- Multi-platform support with Deno's compile feature.
- Customizable login behavior based on credentials sent via headers.
- Retry mechanism when tokens are missing from authenticated logins.
- Error handling and logging to track issues.
- Build tasks for macOS, Linux, and Windows binaries.

## Table of Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Running the API](#running-the-api)
- [API Usage](#api-usage)
- [Authentication](#authentication)
- [Private and Beta Branches](#private-and-beta-branches)
- [Building Binaries](#building-binaries)
- [Tasks](#tasks)
- [Contributing](#contributing)

## Requirements

- Deno >= 2.5 (tested with 2.5.6)
- Steam account (optional, for authenticated access)
- Redis (optional, for caching)

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/denizkoekden/steamcmd-deno.git
   cd steamcmd-deno
   ```

2. Install dependencies: Deno automatically installs required npm dependencies
   when the project runs (and will create a `node_modules` folder when needed).
   You only need Deno installed locally.

3. Set up environment variables: Create a `.env` file in the root directory and
   configure the following:
   ```
   PORT=8000
   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_PASSWORD=your_password  # Optional if your Redis instance requires authentication
   CACHE_EXPIRATION=3600
   LOG_LEVEL=INFO
   CACHE_ENABLED=true # optional, defaults to Redis availability
   APP_VERSION=dev    # optional, returned by the /v1/version endpoint
   ```

## Running the API

To start the API locally, run:

```bash
deno task start
```

This will start the server on the specified port (`8000` by default).

### Example Request

You can query app information by `appId` using the following endpoint:

```
GET http://localhost:8000/v1/info/{appId}
```

## API Usage

The API exposes the following routes:

- `GET /v1/info/:appId`: Fetches app information for a given Steam `appId`.
  Supports both authenticated and anonymous logins. Returns `400` for malformed
  `appId` or incomplete credentials.
- `GET /v1/version`: Retrieves the current API version.

## Authentication

### Authenticated vs. Anonymous Login

The API supports both **authenticated** and **anonymous** logins when querying
Steam app data.

- **Authenticated Login**: When Steam credentials are provided in the request
  headers (`username` and `password`), the API logs in with these credentials to
  fetch the app data.
- **Anonymous Login**: If no credentials are provided, the API falls back to
  anonymous login for querying the Steam app data.

#### Sending Credentials

To make an authenticated request, send the `username` and `password` in the
request headers:

```bash
curl -X GET http://localhost:8000/v1/info/{appId} \
     -H "username: your_steam_username" \
     -H "password: your_steam_password"
```

If no credentials are sent, the request is handled anonymously by default:

```bash
curl -X GET http://localhost:8000/v1/info/{appId}
```

### Token Handling

Certain Steam applications require a token to fetch more detailed information.
If an authenticated request returns a `missingToken: true` response, the API
automatically retries the request as **anonymous**, and logs a warning if the
token is still missing after retrying.

This behavior ensures the API delivers the most complete app data available,
whether using authenticated or anonymous login.

## Private and Beta Branches

Since November 2024, Valve strips the metadata (`buildid`, `timeupdated`, ...)
of password-protected branches from the standard PICS protocol response. Only a
top-level `appinfo.depots.privatebranches = "1"` marker remains. Resolving the
hidden branch requires the new `CMsgClientPICSPrivateBetaRequest` protocol
message, which the `steam-user` npm package does not implement.

To work around this, the API shells out to a bundled `steamcmd` binary **only
when a branch password is supplied**. Public/authenticated requests without a
beta password continue to use the fast `steam-user` path.

### Requesting a Private Branch

Send the branch **name** and **password** as request headers (or as
`?beta_branch=`/`?beta_password=` query parameters). **Both are required** —
modern steamcmd's `set_app_beta_password <appid> -beta <branch> -betapassword
<pw>` syntax mandates the branch name; the legacy two-arg form silently fails.

The response shape is identical to a normal request — the unlocked branch
simply appears inside `appinfo.depots.branches`.

```bash
# Anonymous + beta password
curl http://localhost:8000/v1/info/3951240 \
     -H "X-Steam-Beta-Branch: development" \
     -H "X-Steam-Beta-Password: your_branch_password"

# Authenticated + beta password
curl http://localhost:8000/v1/info/3951240 \
     -u "steam_user:steam_password" \
     -H "X-Steam-Beta-Branch: development" \
     -H "X-Steam-Beta-Password: your_branch_password"
```

Sending `X-Steam-Beta-Password` without `X-Steam-Beta-Branch` returns a `400
Bad Request`.

The relevant `buildid` is then at:

```text
appinfo.depots.branches.<branchname>.buildid
```

### steamcmd Configuration

The bundled Docker image installs `steamcmd` to `/opt/steamcmd/steamcmd.sh` and
sets `STEAMCMD_PATH` automatically. For bare-metal Deno deployments, install
`steamcmd` yourself and configure:

```bash
STEAMCMD_PATH=/usr/games/steamcmd      # or wherever steamcmd lives
STEAMCMD_TIMEOUT_MS=60000              # optional, default 60s
```

### Performance and Caveats

- A `steamcmd` invocation takes roughly **5–15 seconds** (login + app info
  fetch). The first call after build is slower because steamcmd self-updates.
- Responses are cached in Redis under a separate key
  (`<appId>::beta:<password>`) so the public branch cache is never polluted with
  branch-specific data.
- Concurrent `steamcmd` invocations are serialized internally to avoid
  corrupting steamcmd's shared content directory state.

## Building Binaries

You can compile this Deno project into standalone binaries for different
platforms. Available build tasks are defined in the `deno.json` file.

To build binaries for all platforms:

```bash
deno task build_all
```

Or, for specific platforms:

```bash
# macOS x86_64
deno task build_mac_x86

# macOS ARM
deno task build_mac_arm

# Windows
deno task build_win

# Linux x86_64
deno task build_linux_x86

# Linux ARM
deno task build_linux_arm
```

The binaries will be output to the `bin/` directory.

## Tasks

Here are the available tasks defined in `deno.json`:

- `deno task start`: Starts the API server.
- `deno task lint`: Lints the codebase.
- `deno task fmt`: Formats the codebase.
- `deno task check`: Runs format + lint in check mode.
- `deno task build` / `build_all`: Builds the project for all platforms.
- `deno task build_mac_x86`: Builds the macOS (x86) binary.
- `deno task build_mac_arm`: Builds the macOS (ARM) binary.
- `deno task build_win`: Builds the Windows binary.
- `deno task build_linux_x86`: Builds the Linux (x86) binary.
- `deno task build_linux_arm`: Builds the Linux (ARM) binary.

## Docker & Releases

- A Docker image is built on the `release` branch and published to GHCR
  (`ghcr.io/<owner>/steamcmd-deno`) tagged with the release version and
  `latest`.
- Build args embed `APP_VERSION` into the image for `/v1/version`.
- Local development with Docker Compose:
  ```bash
  docker compose up --build
  ```

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request
with your changes. Ensure that you follow the code style by running `deno lint`
and `deno fmt` before submitting.

1. Fork the repo.
2. Create a new branch: `git checkout -b feature-branch-name`.
3. Commit your changes: `git commit -m 'Add some feature'`.
4. Push to the branch: `git push origin feature-branch-name`.
5. Open a pull request.
