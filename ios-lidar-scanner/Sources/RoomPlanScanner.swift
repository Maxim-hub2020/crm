import RoomPlan
import ARKit
import simd
import SwiftUI
import UIKit

struct LiveFixtureMark {
    let type: String
    let label: String
    let position: SIMD3<Float>
}

@MainActor
final class RoomPlanController: ObservableObject {
    weak var captureView: RoomCaptureView?
    @Published private(set) var marks: [LiveFixtureMark] = []

    func stop() {
        captureView?.captureSession.stop()
    }

    func mark(type: String, label: String) -> String {
        guard let session = captureView?.captureSession.arSession,
              let frame = session.currentFrame else { return "Камера ещё не определила стену. Наведите её на поверхность и попробуйте снова." }
        let center = CGPoint(x: 0.5, y: 0.5)
        let targets: [ARRaycastQuery.Target] = [.existingPlaneGeometry, .estimatedPlane]
        guard let hit = targets.lazy.compactMap({ target in
            guard let query = frame.raycastQuery(from: center, allowing: target, alignment: .vertical) else { return nil }
            return session.raycast(query).first
        }).first else { return "Не удалось определить точку на стене. Наведите метку на розетку и подождите секунду." }
        let translation = hit.worldTransform.columns.3
        marks.append(LiveFixtureMark(type: type, label: label,
            position: SIMD3<Float>(translation.x, translation.y, translation.z)))
        return "\(label) отмечена. Всего отметок: \(marks.count)."
    }
}

struct RoomPlanScanner: UIViewRepresentable {
    @ObservedObject var controller: RoomPlanController
    let onFinished: (CapturedRoom) -> Void
    let onFailed: (Error) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinished: onFinished, onFailed: onFailed)
    }

    func makeUIView(context: Context) -> RoomCaptureView {
        let captureView = RoomCaptureView(frame: .zero)
        captureView.delegate = context.coordinator
        captureView.captureSession.delegate = context.coordinator
        controller.captureView = captureView
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        return captureView
    }

    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}

    static func dismantleUIView(_ uiView: RoomCaptureView, coordinator: Coordinator) {
        uiView.captureSession.stop()
    }

    @objc(CEHRoomCaptureCoordinator)
    final class Coordinator: NSObject, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
        let onFinished: (CapturedRoom) -> Void
        let onFailed: (Error) -> Void

        init(onFinished: @escaping (CapturedRoom) -> Void, onFailed: @escaping (Error) -> Void) {
            self.onFinished = onFinished
            self.onFailed = onFailed
        }

        // Runtime callbacks cannot be restored from a UIKit archive.
        required init?(coder: NSCoder) { return nil }

        func encode(with coder: NSCoder) {}

        func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
            if let error { onFailed(error); return false }
            return true
        }

        func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
            if let error { onFailed(error) }
            else { onFinished(processedResult) }
        }
    }
}

enum RoomPlanConverter {
    static func normalizedFixture(local: SIMD3<Float>, dimensions: SIMD3<Float>) -> NormalizedPoint? {
        guard dimensions.x > 0, dimensions.y > 0, abs(local.z) < 0.5 else { return nil }
        let x = Double(local.x / dimensions.x + 0.5)
        let y = Double(0.5 - local.y / dimensions.y)
        guard (-0.05...1.05).contains(x), (-0.05...1.05).contains(y) else { return nil }
        return NormalizedPoint(x: min(max(x, 0.03), 0.97), y: min(max(y, 0.03), 0.97))
    }

    static func result(from room: CapturedRoom, marks: [LiveFixtureMark]) -> ScanResult {
        let fallbackContour = [
            NormalizedPoint(x: 0, y: 0), NormalizedPoint(x: 1, y: 0),
            NormalizedPoint(x: 1, y: 1), NormalizedPoint(x: 0, y: 1),
        ]
        let walls = room.walls.filter { $0.dimensions.x > 0 && $0.dimensions.y > 0 }
        let selectedWall = marks.first.flatMap { mark in
            walls.min(by: { distance(to: mark.position, wall: $0) < distance(to: mark.position, wall: $1) })
        } ?? walls.max(by: { $0.dimensions.x * $0.dimensions.y < $1.dimensions.x * $1.dimensions.y })
        guard let selectedWall else {
            return ScanResult(wall: ScannedWall(contour: fallbackContour, confidence: 0.2), elements: [],
                warnings: ["LiDAR не определил стену; отметки не перенесены. Проверьте замер вручную."])
        }
        let width = Int((selectedWall.dimensions.x * 1000).rounded())
        let height = Int((selectedWall.dimensions.y * 1000).rounded())
        let wall = ScannedWall(contour: fallbackContour, confidence: 0.92,
            width_mm: min(max(width, 100), 20000), height_mm: min(max(height, 100), 20000))
        let elements = marks.compactMap { mark -> ScannedElement? in
            let local = simd_inverse(selectedWall.transform) * SIMD4<Float>(mark.position.x, mark.position.y, mark.position.z, 1)
            guard let point = normalizedFixture(local: SIMD3<Float>(local.x, local.y, local.z), dimensions: selectedWall.dimensions) else { return nil }
            return ScannedElement(type: mark.type, x: point.x, y: point.y, confidence: 0.9, label: mark.label)
        }
        let omitted = marks.count - elements.count
        return ScanResult(wall: wall, elements: elements,
            warnings: omitted > 0 ? ["\(omitted) отметок вне выбранной стены не перенесены. Для другой стены создайте отдельный лист."] : [])
    }

    private static func distance(to position: SIMD3<Float>, wall: CapturedRoom.Surface) -> Float {
        let local = simd_inverse(wall.transform) * SIMD4<Float>(position.x, position.y, position.z, 1)
        let outsideX = max(abs(local.x) - wall.dimensions.x / 2, 0)
        let outsideY = max(abs(local.y) - wall.dimensions.y / 2, 0)
        return abs(local.z) + outsideX + outsideY
    }
}
