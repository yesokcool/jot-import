// Zips a folder exactly the way Jot's ZipBuilder does: NSFileCoordinator's
// .forUploading read option (macOS). Usage: swift zip-folder.swift <folder> <out.zip>
import Foundation
let args = CommandLine.arguments
let folder = URL(fileURLWithPath: args[1], isDirectory: true)
let dest = URL(fileURLWithPath: args[2])
let fm = FileManager.default
try? fm.removeItem(at: dest)
var error: NSError?
var ok = false
NSFileCoordinator().coordinate(readingItemAt: folder, options: .forUploading, error: &error) { zipped in
    ok = (try? fm.copyItem(at: zipped, to: dest)) != nil
}
if let error { print("error: \(error)") }
print(ok ? "ok" : "failed")
exit(ok ? 0 : 1)
