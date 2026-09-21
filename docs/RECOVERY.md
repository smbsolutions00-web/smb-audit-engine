# Source recovery record

- Recovered on: 2026-09-21
- Original Perplexity task: `fa3b9e95-cca7-4599-8801-41a7be014890`
- Authoritative Git repository: `https://github.com/smbsolutions00-web/smb-audit-engine.git`
- Recovered branch/head: `main` at `a368afd57404ba39431ded6ae113aacbc1054844`
- Referenced auth commit verified in history: `0b552fc`
- Perplexity artifact ZIP SHA-256:
  `738615acffa0079168256da42bc0996fc579be805e6b7b739547a9604edd5fb4`

The downloadable Perplexity artifact contained only the compiled static client
(`index.html` plus hashed assets). The Git repository contained the complete
React client, Express server, SQLite storage layer, Render configuration,
templates, and full build history, so it was selected as the authoritative
source. No production service, Render setting, DNS record, or API credential
was changed during recovery.
