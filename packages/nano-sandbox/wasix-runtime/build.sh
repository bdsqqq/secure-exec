#!/bin/bash
set -e

cd "$(dirname "$0")"

# Build Rust to WASM
cargo build --target wasm32-wasip1 --release

# Package into .webc (remove existing first)
rm -f ../assets/runtime.webc
wasmer package build -o ../assets/runtime.webc

echo "Built runtime.webc"
