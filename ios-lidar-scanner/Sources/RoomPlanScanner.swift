import RoomPlan
import SwiftUI
import UIKit

@MainActor
final class RoomPlanController: ObservableObject {
    weak var captureView: RoomCaptureView?

    func stop() {
        captureView?.captureSession.stop()
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

    final class Coordinator: NSObject, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
        let onFinished: (CapturedRoom) -> Void
        let onFailed: (Error) -> Void

        init(onFinished: @escaping (CapturedRoom) -> Void, onFailed: @escaping (Error) -> Void) {
            self.onFinished = onFinished
            self.onFailed = onFailed
        }

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
    static func wall(from room: CapturedRoom) -> ScannedWall {
        guard let largest = room.walls.max(by: { $0.dimensions.x * $0.dimensions.y < $1.dimensions.x * $1.dimensions.y }) else {
            return ScannedWall(contour: [
                NormalizedPoint(x: 0.05, y: 0.05), NormalizedPoint(x: 0.95, y: 0.05),
                NormalizedPoint(x: 0.95, y: 0.95), NormalizedPoint(x: 0.05, y: 0.95),
            ], confidence: 0.4)
        }
        let aspect = Double(largest.dimensions.x / max(largest.dimensions.y, 0.001))
        let insetX = aspect > 1 ? 0.04 : min(0.2, (1 - aspect) / 2)
        let insetY = aspect < 1 ? 0.04 : min(0.2, (1 - 1 / aspect) / 2)
        return ScannedWall(contour: [
            NormalizedPoint(x: insetX, y: insetY), NormalizedPoint(x: 1 - insetX, y: insetY),
            NormalizedPoint(x: 1 - insetX, y: 1 - insetY), NormalizedPoint(x: insetX, y: 1 - insetY),
        ], confidence: 0.92)
    }
}

