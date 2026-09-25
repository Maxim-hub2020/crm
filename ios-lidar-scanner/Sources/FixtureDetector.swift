import UIKit
import Vision

enum FixtureDetector {
    static func detect(in image: UIImage) async throws -> [ScannedElement] {
        guard let cgImage = image.cgImage else { return [] }
        return try await withCheckedThrowingContinuation { continuation in
            let rectangles = VNDetectRectanglesRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let observations = (request.results as? [VNRectangleObservation]) ?? []
                let elements = observations.compactMap(classifyRectangle)
                continuation.resume(returning: elements)
            }
            rectangles.maximumObservations = 24
            rectangles.minimumConfidence = 0.45
            rectangles.minimumSize = 0.025
            rectangles.minimumAspectRatio = 0.35
            rectangles.maximumAspectRatio = 1.0
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
            DispatchQueue.global(qos: .userInitiated).async {
                do { try handler.perform([rectangles]) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private static func classifyRectangle(_ observation: VNRectangleObservation) -> ScannedElement? {
        let box = observation.boundingBox
        guard box.width > 0.015, box.height > 0.015, box.width * box.height < 0.18 else { return nil }
        // Vision uses a lower-left origin; CRM receives a top-left origin.
        let x = box.midX
        let y = 1 - box.midY
        let ratio = box.width / max(box.height, 0.0001)
        let type: String
        let label: String
        if ratio > 2.4 {
            type = "socket_triple"
            label = "Возможная тройная розетка"
        } else if ratio > 1.45 {
            type = "socket_double"
            label = "Возможная двойная розетка"
        } else if ratio > 0.72 {
            type = "socket_single"
            label = "Возможная розетка или вырез"
        } else {
            type = "cut_rect"
            label = "Возможный прямоугольный вырез"
        }
        return ScannedElement(
            type: type,
            x: x,
            y: y,
            width: box.width,
            height: box.height,
            confidence: Double(observation.confidence) * 0.78,
            label: label
        )
    }
}

