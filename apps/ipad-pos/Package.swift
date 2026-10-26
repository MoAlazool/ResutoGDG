// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ResutoPOS", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name:"ResutoCore",targets:["ResutoCore"]), .executable(name:"ResutoStagingProbe",targets:["ResutoStagingProbe"])],
    targets: [.target(name:"ResutoCore"), .executableTarget(name:"ResutoStagingProbe",dependencies:["ResutoCore"]),
              .testTarget(name:"ResutoCoreTests",dependencies:["ResutoCore"],resources:[.copy("Fixtures")])]
)
