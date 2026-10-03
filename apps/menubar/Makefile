# Mesh Node menu-bar app. Requires macOS 13+ and Xcode 15+ command line tools (swift 5.9).
#
#   make run     swift run (no bundle: Dock-less via activation policy, launch-at-login disabled)
#   make app     build/MeshNode.app, ad-hoc signed       CODESIGN_IDENTITY="Developer ID Application: ..." make app
#   make dmg     build/MeshNode-<version>-arm64.dmg + .sha256 (unsigned by default)
#                CODESIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=mesh-notary make dmg   (sign + notarise + staple)
#   make test    swift test (MeshNodeCore only; runs on Linux too)
#   make open    build and open the .app
#   make clean

SHELL := /bin/sh
.DEFAULT_GOAL := help

.PHONY: help run build app dmg test open clean fmt

help:
	@sed -n '3,10p' Makefile | sed 's/^#//'

run:
	swift run MeshNode

build:
	swift build

test:
	swift test

app:
	sh scripts/make-app.sh

open: app
	open build/MeshNode.app

dmg: app
	sh scripts/make-dmg.sh

clean:
	rm -rf .build build

# swift-format ships with Xcode 16; older toolchains: brew install swift-format
fmt:
	swift-format format -i -r Sources Tests Package.swift
