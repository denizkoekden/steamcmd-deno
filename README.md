# SteamCMD Deno API

This project provides a Deno-based API for querying Steam application data using `steam-user` npm package. It supports Redis caching and can be deployed across multiple platforms. The API allows fetching detailed information about Steam apps by their `appId`.

## Features

- Query Steam app data using the Steam Client protocol (via anonymous login).
- Cache responses in Redis to improve performance.
- Multi-platform support with Deno's compile feature.
- Error handling and logging to track issues.
- Build tasks for macOS, Linux, and Windows binaries.

## Table of Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Running the API](#running-the-api)
- [API Usage](#api-usage)
- [Building Binaries](#building-binaries)
- [Tasks](#tasks)
- [Contributing](#contributing)

## Requirements

- Deno >= 2.00
- Steam account (optional, for authenticated access)
- Redis (optional, for caching)

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/denizkoekden/steamcmd-deno.git
   cd steamcmd-deno
   ```

2. Install dependencies:
   Deno automatically installs required npm dependencies when the project runs. You don’t need to manually install anything except for Deno.

3. Set up environment variables:
   Create a `.env` file in the root directory and configure the following:
   ```
   PORT=8000
   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_PASSWORD=your_password  # Optional if your Redis instance requires authentication
   CACHE_EXPIRATION=3600
   LOG_LEVEL=INFO
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
- `GET /v1/version`: Retrieves the current API version.

## Building Binaries

You can compile this Deno project into standalone binaries for different platforms. Available build tasks are defined in the `deno.json` file.

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
- `deno task build`: Builds the project for all platforms.
- `deno task build_mac_x86`: Builds the macOS (x86) binary.
- `deno task build_mac_arm`: Builds the macOS (ARM) binary.
- `deno task build_win`: Builds the Windows binary.
- `deno task build_linux_x86`: Builds the Linux (x86) binary.
- `deno task build_linux_arm`: Builds the Linux (ARM) binary.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes. Ensure that you follow the code style by running `deno lint` and `deno fmt` before submitting.

1. Fork the repo.
2. Create a new branch: `git checkout -b feature-branch-name`.
3. Commit your changes: `git commit -m 'Add some feature'`.
4. Push to the branch: `git push origin feature-branch-name`.
5. Open a pull request.