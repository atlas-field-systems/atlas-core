#!/bin/sh
set -eu

version=2.0.39
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform=linux-x64
    checksum=6cf462fd8f70b094a4950ebb709a9c4ffd8f1d1189d9cedf1fd63cd5d041c7ab
    ;;
  Linux-aarch64|Linux-arm64)
    platform=linux-arm64
    checksum=71b43e1bb9313dd14ac2b0553b854e41c39d65ecaa47040796ebff4a46f54a97
    ;;
  Darwin-arm64)
    platform=darwin-arm64
    checksum=d4aaef68de545727429ce83b9e88ff3273bf068df599e3542e446755b5f3d83a
    ;;
  Darwin-x86_64)
    platform=darwin-x64
    checksum=a512cfd1d29ec24c640126a6a640e597b4ea1abe0aefbda7cc57efd85ab56e22
    ;;
  *)
    echo 'Bend 2.0.39 supports Linux and macOS on x64 and arm64.' >&2
    exit 1
    ;;
esac

experiment_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_dir="$experiment_dir/.tools/bend-$version"
if [ -x "$install_dir/bin/bend" ]; then
  "$install_dir/bin/bend" version
  exit
fi

mkdir -p "$experiment_dir/.tools"
download_dir=$(mktemp -d "$experiment_dir/.tools/download.XXXXXX")
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
archive="bend-$version-$platform.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://github.com/bendlang/bend/releases/download/v$version/$archive" \
  -o "$download_dir/$archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$download_dir/$archive")
else
  actual=$(shasum -a 256 "$download_dir/$archive")
fi
if [ "${actual%% *}" != "$checksum" ]; then
  echo 'Bend archive checksum differs from the pinned release.' >&2
  exit 1
fi
mkdir "$download_dir/install"
tar -xzf "$download_dir/$archive" -C "$download_dir/install"
mv "$download_dir/install" "$install_dir"
BEND_NO_TELEMETRY=1 "$install_dir/bin/bend" version
