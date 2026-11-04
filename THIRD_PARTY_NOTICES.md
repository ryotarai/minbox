# Third-party notices

minbox contains code, text and designs ported or adapted from
[Plannotator](https://github.com/backnotprop/plannotator) by backnotprop,
which is dual-licensed under MIT and Apache-2.0. minbox uses it under the MIT License.

## Where Plannotator material is used

- `internal/question` — question-block parsing and the answer reply text (ported from TypeScript to Go)
- `internal/server/feedback.go` — annotation feedback format (ported)
- `internal/server/attachments.go` — HTML embed CSS (`embedBaseCSS`, copied) and embed init JS (ported); some error messages
- `internal/attach/kind.go` — file-kind detection regular expressions
- `web/src/lib/uploads.tsx`, `web/src/lib/attachments.ts` — `isLongPaste`, `pastedName`, `formatBytes`, `sizeLine`, `changeState`
- `web/src/components/MessageBody.tsx` — `attachmentForLink` (simplified port)
- `plugin/minbox/hooks/text.ts` — `ATTACHMENTS_GUIDE` and other tool-description text
- UI strings (for example the queued-reply notice) and section labels

## Plannotator license (MIT)

    MIT License

    Copyright (c) 2025 backnotprop

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
