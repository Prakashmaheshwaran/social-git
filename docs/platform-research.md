# Platform Adapter Research

This document collects research on potential platform adapters for Social Git.

## LinkedIn

### Status: Research Required

### Potential Libraries

**1. linkedin-api (Python)**
- Repository: Various forks exist
- License: MIT (varies by fork)
- Notes: Uses official LinkedIn API, not direct session transport
- Verdict: Not suitable (official API)

**2. linkedin-scraper (Python)**
- Repository: Various implementations
- License: MIT (varies)
- Notes: Uses web scraping with browser automation
- Verdict: Not suitable (browser automation)

**3. Custom Implementation**
- Option: Extract protocol corpus from known sources
- Protocol: Direct HTTPS to linkedin.com
- Authentication: Session cookies (li_at, JSESSIONID)
- Research needed: Current endpoint structure and API changes

### Known Challenges

- LinkedIn has aggressive anti-scraping measures
- Session cookies have short expiration
- Complex authentication flow
- No stable public API for all operations
- Frequent protocol changes

### Capabilities to Research

- Profile read
- Post read
- Feed/listing
- Comment read
- Post create
- Comment create
- Like/unlike
- Share/repost

### Admission Status

- **Source Review**: Not started
- **Protocol Corpus**: Not extracted
- **License Review**: Not started
- **Admission Decision**: Deferred pending research

---

## Instagram

### Status: Research Required

### Potential Libraries

**1. instagrapi (Python)**
- Repository: adw0rd/instagrapi
- License: MIT
- Notes: Reverse-engineered private API, uses HTTP requests
- Last updated: 2024
- Stars: 4.5k+
- Verdict: Potential candidate (HTTP-based, no browser)

**2. instagram-scraper (Python)**
- Repository: Various implementations
- License: MIT (varies)
- Notes: Many use browser automation
- Verdict: Not suitable (browser automation)

**3. Custom Implementation**
- Option: Extract protocol corpus from instagrapi or similar
- Protocol: Direct HTTPS to instagram.com and i.instagram.com
- Authentication: Session ID cookies, sessionid, ds_user_id
- Research needed: Current API endpoints and auth flow

### Known Challenges

- Instagram has aggressive rate limiting
- Session cookies require regular refresh
- Challenge mechanisms (CAPTCHA, checkpoint)
- API endpoints change frequently
- Media upload is complex

### Capabilities to Research

- Profile read
- Post read
- Stories read
- Feed/listing
- Comment read
- Post create (image/video)
- Comment create
- Like/unlike
- Follow/unfollow

### Admission Status

- **Source Review**: Not started
- **Protocol Corpus**: Not extracted
- **License Review**: Not started (instagrapi is MIT)
- **Admission Decision**: Deferred pending research

---

## YouTube

### Status: Research Required

### Potential Libraries

**1. youtube-transcript-api (Python)**
- Repository: jdepoix/youtube-transcript-api
- License: MIT
- Notes: Only for transcripts, not full API
- Verdict: Not suitable (limited scope)

**2. yt-dlp (Python)**
- Repository: yt-dlp/yt-dlp
- License: Unlicense (public domain)
- Notes: Video downloader, not social interaction
- Verdict: Not suitable (wrong purpose)

**3. pytube (Python)**
- Repository: pytube/pytube
- License: MIT
- Notes: Frequently broken due to YouTube changes
- Verdict: Not suitable (unmaintained)

**4. Custom Implementation**
- Option: Extract protocol corpus
- Protocol: Direct HTTPS to youtube.com
- Authentication: SAPISID, HSID, SSID cookies
- Research needed: Current API structure (INNERTUBE API)

### Known Challenges

- YouTube uses complex INNERTUBE API
- Requires multiple authentication cookies
- Frequent protocol changes
- No stable public API for social features
- Comments have nested threading
- API requires token-based authentication

### Capabilities to Research

- Channel profile read
- Video metadata read
- Comments read
- Comment create
- Like/unlike
- Subscribe/unsubscribe
- Playlist read

### Admission Status

- **Source Review**: Not started
- **Protocol Corpus**: Not extracted
- **License Review**: Not started
- **Admission Decision**: Deferred pending research

---

## Research Priorities

Based on ease of implementation and stability:

1. **Instagram** (instagrapi shows promise)
   - HTTP-based, no browser automation
   - Active maintenance
   - MIT license
   - Protocol corpus extraction feasible

2. **LinkedIn** (requires custom implementation)
   - No suitable library found
   - Would require custom protocol extraction
   - Aggressive anti-scraping
   - Lower priority

3. **YouTube** (complex protocol)
   - Complex INNERTUBE API
   - No suitable library
   - Frequent changes
   - Lower priority

---

## Next Steps

For each platform, the research phase should:

1. **Deep Library Review**
   - Audit source code for security issues
   - Verify license compatibility
   - Check for browser automation
   - Check for official API usage
   - Assess maintenance status

2. **Protocol Extraction**
   - Clone library locally
   - Extract minimal protocol corpus
   - Document all endpoints
   - Document authentication flow
   - Record exact commit hashes

3. **Proof of Concept**
   - Implement minimal adapter
   - Write fixture tests
   - Verify protocol works
   - Assess complexity

4. **Admission Decision**
   - Complete source review
   - Complete license review
   - Create admission decision document
   - Recommend proceed or reject

---

## Notes

- This research is deterministic only (no live credentials)
- Live proof requires separate QA authorization
- All research must be documented with exact Git commits
- License notices must be preserved for any extracted code
- Research does not commit to implementation
