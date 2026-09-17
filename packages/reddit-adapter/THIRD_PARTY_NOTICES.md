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
- `reddit_mcp_server/tools/messaging.py`, Git blob
  `27d9be6534f546db1df08e956da95b3b406478c7`, SHA-256
  `4f162c3460c67215030f09397603c47c1016f83d6d7077e22c0f04a8d70ffb2c`

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

The exact-item lookup, media, and private-message protocol shapes are adapted from PRAW version
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
- `praw/models/inbox.py`, Git blob `966160188094154de4517360f45a38cd6051bb10`,
  SHA-256 `5c6eff20fdf7080f1217ed309944bd9489cc5bb14463a9fd95b932a0d6a174cb`
- `praw/models/reddit/message.py`, Git blob `3880427d1c45be1faa0272a8242b0ec5b72094b7`,
  SHA-256 `f17c729373b060ece127c54352f09b076f280a9626267788339ce6ea0a1da773`
- `praw/models/reddit/mixins/messageable.py`, Git blob `ba14f5e187d01ec42509b9e2220be28ae4e4f8f6`,
  SHA-256 `710e1330f86bc7d60defb3c448dadf06ac608d318938821e9575aa2f7bb8f41e`
- `praw/models/reddit/mixins/replyable.py`, Git blob `b5e422c418dffbe3bfe881a2e71ed58ea28f11ea`,
  SHA-256 `ab581a5267b7d7163cbb1357070a40142e2aac1d3c3f44e02fb6baa08534cbdc`

Source: <https://github.com/praw-dev/praw>

PRAW is licensed under the BSD 2-Clause License. The notice below is reproduced
from the pinned upstream `LICENSE.txt` file (Git blob
`81a932a704c89c1698960e8d23d7de13f0845c48`, SHA-256
`a960fd990b0c6883cf8d0015a75f8b1f2657cccf275aa802a27c226c3c861486`).

### BSD 2-Clause License

Copyright (c) 2016, Bryce Boe
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
