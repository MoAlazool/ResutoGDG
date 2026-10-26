#!/usr/bin/env python3
"""Execute the real simulator transport with synthetic fixtures; no network or Apple SDK claim."""
from pathlib import Path
import subprocess, tempfile, argparse
parser=argparse.ArgumentParser()
parser.add_argument('--swiftc',default='swiftc')
args=parser.parse_args()
native=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='resuto-ui-contract-') as directory:
    directory=Path(directory)
    source=(native/'App/UITestBootstrap.swift').read_text().splitlines()
    source='\n'.join(source[1:-1])
    original='let directory = try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true)'
    assert original in source, 'Review fixture persistence path before testing'
    source=source.replace(original,'let directory = URL(fileURLWithPath:ProcessInfo.processInfo.arguments[1])')
    support='''
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
struct Configuration { let apiURL: URL; let supabaseURL: URL; let publicKey: String }
@main enum TransportChecks {
    static func main() async throws {
        let root = URL(fileURLWithPath:ProcessInfo.processInfo.arguments[2])
        var fixtures: [String:Any] = [:]
        for name in ["menu","me","detail","orders","accepted","floor"] {
            fixtures[name] = try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent(name + ".json")))
        }
        func request(_ path: String,method: String = "GET",body: Data? = nil,key: String? = nil) -> URLRequest {
            var r = URLRequest(url:URL(string:"https://api.uitest.invalid/v1/o/org/" + path)!)
            r.httpMethod=method; r.httpBody=body; r.setValue("Bearer ui-contract-token",forHTTPHeaderField:"Authorization")
            if let key { r.setValue(key,forHTTPHeaderField:"Idempotency-Key") }; return r
        }
        let server = try ScenarioTransport(fixtures:fixtures,role:"manager",scenario:"lost-order-until-relaunch",reset:true)
        let key = UUID().uuidString
        let body = Data("{\\"branchId\\":\\"22222222-2222-4222-8222-222222222222\\",\\"channel\\":\\"staff\\",\\"fulfillment\\":\\"pickup\\"}".utf8)
        do { _ = try await server.send(request("orders",method:"POST",body:body,key:key)); preconditionFailure("Fault must lose acknowledgement") }
        catch let e as URLError { precondition(e.code == .networkConnectionLost) }
        let first = try await server.send(request("orders"))
        let original = try JSONDecoder().decode(Page<OrderSummary>.self,from:first.data).items
        precondition(original.count == 1)
        let restarted = try ScenarioTransport(fixtures:fixtures,role:"manager",scenario:"lost-order-until-relaunch",reset:false)
        let replay = try await restarted.send(request("orders",method:"POST",body:body,key:key))
        let accepted = try JSONDecoder().decode(OrderAccepted.self,from:replay.data)
        precondition(accepted.id == original[0].id)
        let availability = Data("{\\"branchId\\":\\"22222222-2222-4222-8222-222222222222\\",\\"available\\":false}".utf8)
        _ = try await restarted.send(request("menu/products/11111111-1111-4111-8111-111111111111/availability",method:"POST",body:availability))
        let menu = try await restarted.send(request("menu"))
        let decoded = try JSONDecoder().decode(Menu.self,from:menu.data)
        precondition(!decoded.products[0].available(branch:"22222222-2222-4222-8222-222222222222"))
        print("PASS: synthetic transport availability, lost acknowledgement, persistent server identity and same-key relaunch replay")
    }
}
'''
    file=directory/'TransportChecks.swift'
    file.write_text(source+'\n'+support)
    executable=directory/'checks'
    subprocess.run([args.swiftc,'-swift-version','5','-parse-as-library',*[str(p) for p in sorted((native/'Sources/ResutoCore').glob('*.swift'))],str(file),'-o',str(executable)],check=True)
    subprocess.run([str(executable),str(directory),str(native/'Tests/ResutoCoreTests/Fixtures')],check=True)
