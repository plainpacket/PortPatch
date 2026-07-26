# Releasing PortPatch

Tagged releases are built on GitHub-hosted Windows and Ubuntu runners. The workflow refuses to publish unless both platform builds, dependency audits, tests, checksums, and provenance attestations succeed.

## Windows executable signing

Windows executables are currently published without an Authenticode signature. This may cause Microsoft Defender SmartScreen to show an unknown-publisher warning. A self-signed certificate is not used because it would not establish a trusted publisher identity on another computer.

If the project later obtains a trusted code-signing certificate or service, signing can be added without changing the portable distribution format. Never commit a certificate or password to the repository.

## Build provenance

GitHub creates an OIDC-backed artifact attestation for each executable and AppImage. Verify a downloaded file with:

```bash
gh attestation verify PortPatch-<version>-windows-x64-portable.exe --repo plainpacket/PortPatch
gh attestation verify PortPatch-<version>-linux-x86_64.AppImage --repo plainpacket/PortPatch
```

The attestation confirms that the file was built by this repository's GitHub Actions workflow. It is separate from Windows publisher signing.

You can also compare the downloaded file with its accompanying checksum:

```powershell
(Get-FileHash .\PortPatch-<version>-windows-x64-portable.exe -Algorithm SHA256).Hash.ToLower()
Get-Content .\PortPatch-<version>-windows-x64-portable.exe.sha256
```

The checksum detects corruption or a mismatched download. Because the checksum and executable are created by the same workflow, the provenance attestation is the stronger check on where the build came from.

## Publishing

1. Update `package.json` to the intended version and update `pnpm-lock.yaml`.
2. Run `pnpm install --frozen-lockfile`, `pnpm audit --audit-level high`, and `pnpm test`.
3. Merge the release commit into `main`.
4. Create a `v<package-version>` tag on that exact commit and push the tag.
5. Confirm that the release contains exactly the Windows executable, Linux AppImage, and one SHA-256 file for each.

The workflow never overwrites an existing release. If publication must be repeated, investigate the failure first and delete the incomplete release before rerunning the workflow.
