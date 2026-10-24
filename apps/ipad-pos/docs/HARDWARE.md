# Hardware compatibility and validation

No physical printer, cash drawer, or iPad was attached to this environment. **No model is certified compatible by this work.** Implemented adapters and research candidates are distinguished below.

| Interface / candidate | Implementation | Discovery/configuration | Arabic | Status / drawer |
|---|---|---|---|---|
| AirPrint-capable printers explicitly listed by Apple/vendor | UIKit print controller with rendered order-summary image | System printer picker; Bonjour `_ipp._tcp`, `_ipps._tcp` | Core Text/UIKit shapes Arabic before printing | Implemented, unverified physically; no drawer API |
| LAN ESC/POS models supporting `GS v 0` raster, 384/576 dots, TCP 9100 | Native Network.framework transport and monochrome raster encoder | Manual private/link-local IPv4, explicit width; no general discovery claim | Raster avoids unsupported Arabic code pages and missing shaping | Experimental adapter, model approval and real tests required; drawer/cutter disabled |
| Epson TM-m30 family / TM-T88 family with correct interface and ePOS support | Vendor adapter **not yet integrated** | Requires model/firmware/SDK selection and vendor discovery | Prefer vendor image/raster path; test actual device | Research candidates only; vendor SDK/license and drawer/status acceptance required |
| Star mC-Print3 / TSP100IV supported by StarXpand | Vendor adapter **not yet integrated** | StarXpand discovery/status APIs after version/license/privacy review | Image commands avoid code-page assumptions | Research candidates only; vendor SDK/real-device/drawer acceptance required |
| Generic Bluetooth, USB, BLE-only, unknown clones | No support claim | No fabricated discovery or universal ESC/POS support | Unknown | Not implemented |

`ReceiptPrinter` separates hardware from `PrintQueue`. AirPrint completion indicates the OS accepted/completed its job, not independently verified paper output. Network adapter completes when local TCP send is processed; it does not parse model-specific printer status or prove paper output. Queue state is deliberately “handed to print system,” never “physically verified.” Timeouts and interrupted sends become uncertain; staff must check paper before reprinting. Stable job IDs help auditing but printers do not promise deduplication. No automatic replay of an uncertain job.

Network raster transmits unencrypted data only to an explicitly configured local IPv4 printer. Use a managed LAN. `NSLocalNetworkUsageDescription` explains the connection. No Bluetooth entitlement, external accessory protocol, SDK binary or MFi claim is included. Arabic glyphs are rendered on iPad, with mixed-direction currency tested separately before device certification. Printer width is hardware dots, not point size. Receipts are operational order summaries, not certified fiscal invoices.

## Real-device test matrix

For each approved exact model/interface/firmware: discovery or manual address; deny/allow local-network permission; connect/reconnect; Wi-Fi roaming and IP changes; printer powered off mid-send; paper out; cover open; buffer overflow/long receipt; simultaneous clients; force-close before/during/after send; duplicate reprint confirmation; reboot; 384/576-dot clipping; darkness and readable small Arabic; Arabic/English/mixed product names and Western digits; totals match server; Test/sandbox labels persist. Record photos, printer status and firmware with the run.

Cash drawer support requires a selected printer/SDK/profile, compatible electrical connector and voltage, a permission/audit policy, and actual open/status tests. No pulse command is sent by this app. Native reconnect logic and manual retry do not substitute for model-specific status monitoring.

## Research sources

- Apple iPad HIG: https://developer.apple.com/design/human-interface-guidelines/designing-for-ipados
- Apple printing API: https://developer.apple.com/documentation/uikit/uiprintinteractioncontroller
- Star official iOS SDK catalog: https://starmicronics.com/support/developers/ios-sdks/
- StarXpand official source, model/version requirements and diagnostic-data notice: https://github.com/star-micronics/StarXpand-SDK-iOS
- Star cash drawer guide: https://star-m.jp/products/s_print/sdk/starxpand/manual/en/cashDrawer.html
- Epson official SDK reference entry: https://download4.epson.biz/sec_pubs/pos/reference_en/epos_sdk_ref/ (verify exact selected SDK/model before adopting)
