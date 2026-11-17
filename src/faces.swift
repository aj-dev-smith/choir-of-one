// Where the face is in each picture: `swift src/faces.swift a.jpg b.jpg ...` prints one line of JSON,
// { "a.jpg": [x, y, w, h] | null, ... }, the largest face found, as fractions of the picture with y down.
// Used by faces.ts to frame each take on the person; macOS only (Vision). Elsewhere faces.ts frames the middle of
// the picture.
import Foundation
import Vision

var found: [String: Any] = [:]
for path in CommandLine.arguments.dropFirst() {
  found[path] = NSNull()
  let request = VNDetectFaceRectanglesRequest()
  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
  guard (try? handler.perform([request])) != nil, let faces = request.results, !faces.isEmpty else { continue }
  let b = faces.max { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }!.boundingBox
  found[path] = [b.minX, 1 - b.maxY, b.width, b.height]
}
let data = try! JSONSerialization.data(withJSONObject: found)
print(String(data: data, encoding: .utf8)!)
