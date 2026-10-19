#!/bin/sh
set -eu

if [ "${NODE_ENV:-}" = production ]; then
  if [ "${OBJECT_STORAGE_DRIVER:-}" != s3 ]; then
    echo 'Production requires OBJECT_STORAGE_DRIVER=s3; local storage is not shared by Web and Worker.' >&2
    exit 1
  fi
  if [ -z "${OBJECT_STORAGE_BUCKET:-}" ] || [ -z "${OBJECT_STORAGE_REGION:-}" ]; then
    echo 'Production object storage requires OBJECT_STORAGE_BUCKET and OBJECT_STORAGE_REGION.' >&2
    exit 1
  fi
  if [ -n "${OBJECT_STORAGE_ENDPOINT:-}" ] && { [ -z "${OBJECT_STORE_ACCESS_KEY_ID:-}" ] || [ -z "${OBJECT_STORE_SECRET_ACCESS_KEY:-}" ]; }; then
    echo 'A custom S3 endpoint requires its own OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY.' >&2
    exit 1
  fi
  if [ -n "${OBJECT_STORE_ACCESS_KEY_ID:-}" ] && [ -z "${OBJECT_STORE_SECRET_ACCESS_KEY:-}" ] ||
     [ -z "${OBJECT_STORE_ACCESS_KEY_ID:-}" ] && [ -n "${OBJECT_STORE_SECRET_ACCESS_KEY:-}" ]; then
    echo 'Object storage access key and secret must be configured together.' >&2
    exit 1
  fi
fi

exec "$@"
