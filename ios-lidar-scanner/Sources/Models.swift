import Foundation

struct ScanRequest: Equatable {
    let sessionID: String
    let token: String
    let uploadURL: URL
    let roomName: String

    init?(url: URL) {
        guard url.scheme == "cehcrm-lidar",
              url.host == "scan",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        guard let sessionID = values["session"], !sessionID.isEmpty,
              let token = values["token"], !token.isEmpty,
              let uploadURL = URL(string: values["upload_url"] ?? "") else { return nil }
        self.sessionID = sessionID
        self.token = token
        self.uploadURL = uploadURL
        self.roomName = values["room"] ?? "Комната"
    }
}

struct NormalizedPoint: Codable {
    let x: Double
    let y: Double
}

struct ScannedWall: Codable {
    let contour: [NormalizedPoint]
    let confidence: Double
}

struct ScannedElement: Codable, Identifiable {
    let id: UUID
    let type: String
    let x: Double
    let y: Double
    let width: Double?
    let height: Double?
    let diameter: Double?
    let confidence: Double
    let label: String

    enum CodingKeys: String, CodingKey {
        case type, x, y, width, height, diameter, confidence, label
    }

    init(type: String, x: Double, y: Double, width: Double? = nil, height: Double? = nil, diameter: Double? = nil, confidence: Double, label: String) {
        self.id = UUID()
        self.type = type
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.diameter = diameter
        self.confidence = confidence
        self.label = label
    }
}

struct ScanResult: Codable {
    let wall: ScannedWall
    let elements: [ScannedElement]
    let warnings: [String]
}

struct ScanUploadEnvelope: Codable {
    let result: ScanResult
}

