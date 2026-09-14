# Third-party notices

This package contains a bounded JavaScript adaptation of endpoint mappings and
field normalizers from `reddit-lyr` manifest version `0.1.1` at commit
`87ec32aff905923ecd156e7951c168adfdf6fac1`:

- `reddit_mcp_server/scraping/api_client.py`, Git blob
  `1a18f05cb12c80094826365557f06dda7953a499`, SHA-256
  `f1c4a33c06e5357b790801d81b849d98e108ca081cecd4ac03563b7ab727185f`
- `reddit_mcp_server/normalizer.py`, Git blob
  `c6be236df1b349d9d38a42f3f90e1b7815a0bfae`, SHA-256
  `f552d8853827a1538b9d354c96351b302125200680f2af33b8a0653169151f54`

Source: <https://github.com/ishan-parihar/reddit-lyr>

The upstream application, transport, retry loop, session storage, cookie
bootstrap, MCP and CLI layers, dependency graph, and global client state are not
included.

## MIT License

Copyright (c) 2026 Ishan Parihar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## PRAW protocol evidence

The exact-item lookup and media protocol shapes are adapted from PRAW version
`8.0.3` at commit `fdc29bb103ad652eea6740c77c2be099d1c1357e`. PRAW is
used only as source-reviewed protocol evidence. Its package, OAuth transport,
credentials, retry behavior, and official-API client are not included or used
at runtime.

- `praw/endpoints.py`, Git blob `5fe4de568f3bda0fec2c1c3e8f3c57d52f3354b9`,
  SHA-256 `487c557e5289a432055ddbb5cc2d4793df63a2805fc66412e3cb0936b0d76299`
- `praw/models/media.py`, Git blob `e865049549deabd62cb0b05916e5266bf152876f`,
  SHA-256 `d84de7a378a1bb512428359ac3fd7f9bcdd5fb307b4befdfce3fd742c538f530`
- `praw/models/reddit/subreddit/subreddit.py`, Git blob
  `64f87f83150f471cf6310d48ea0f626c2790feb1`, SHA-256
  `c01634ba8c69e786b09bab10ef5495cb51244743c4dc4e2cef0f2e1c246d68b6`
- `praw/reddit.py`, Git blob `b240ec0102f493b7f7d1265661500dfa05c419d3`,
  SHA-256 `180186fa70aa31a9566adc19e06e211f174fbb3ecc18110f183e7b1580fc1eaf`

Source: <https://github.com/praw-dev/praw>

PRAW is Copyright (c) 2016, PRAW Development Monarchy and licensed under the
BSD 2-Clause License. The full license is available in the pinned upstream
`LICENSE.txt` file (Git blob `81a932a704c89c1698960e8d23d7de13f0845c48`,
SHA-256 `a960fd1f527c8ff271e155f3645fdbc4bec169040893689d415f64448d834bec`).
