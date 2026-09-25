import Foundation

enum ScanUploader {
    static func upload(_ result: ScanResult, request scanRequest: ScanRequest) async throws {
        var request = URLRequest(url: scanRequest.uploadURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(scanRequest.token, forHTTPHeaderField: "X-Scan-Token")
        request.httpBody = try JSONEncoder().encode(ScanUploadEnvelope(result: result))
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}

