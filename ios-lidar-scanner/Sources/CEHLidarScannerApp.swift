import RoomPlan
import SwiftUI
import UIKit
import AVFoundation

@main
struct CEHLidarScannerApp: App {
    @State private var request: ScanRequest?

    var body: some Scene {
        WindowGroup {
            CRMAppView(request: $request)
                .onOpenURL { request = ScanRequest(url: $0) }
        }
    }
}

struct CRMAppView: View {
    @Binding var request: ScanRequest?
    @Environment(\.scenePhase) private var scenePhase
    @State private var cameraAllowed = false
    @State private var permissionChecked = false

    var body: some View {
        CRMWebView { request = $0 }
            .sheet(isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } })) {
                NavigationStack {
                    Group {
                        if !RoomCaptureSession.isSupported {
                            ContentUnavailableView("LiDAR недоступен", systemImage: "viewfinder", description: Text("Для сканирования нужен iPhone с LiDAR. Ручной замер доступен в CRM."))
                        } else if cameraAllowed, let request {
                            ScannerFlowView(request: request)
                        } else if permissionChecked {
                            VStack {
                                Text("Разрешите доступ к камере в настройках iPhone.")
                                Button("Открыть настройки") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }
                            }.padding()
                        } else { ProgressView() }
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Вернуться в CRM") { request = nil }
                        }
                    }
                    .task {
                        guard RoomCaptureSession.isSupported else { return }
                        permissionChecked = false
                        cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
                        permissionChecked = true
                    }
                    .onChange(of: scenePhase) { _, phase in
                        if phase == .active {
                            cameraAllowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
                        }
                    }
                }
            }
    }
}

struct ScannerFlowView: View {
    let request: ScanRequest
    @StateObject private var controller = RoomPlanController()
    @State private var capturedRoom: CapturedRoom?
    @State private var wallImage: UIImage?
    @State private var isSending = false
    @State private var message = "Медленно проведите камерой по всей стене."
    @State private var showCamera = false

    var body: some View {
        ZStack(alignment: .bottom) {
            if capturedRoom == nil {
                RoomPlanScanner(controller: controller) { room in
                    capturedRoom = room
                    message = "Контур готов. Сфотографируйте стену прямо для поиска розеток и вырезов."
                    showCamera = true
                } onFailed: { error in
                    message = "Ошибка LiDAR: \(error.localizedDescription)"
                }
                .ignoresSafeArea()
            } else {
                VStack(spacing: 18) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
                    Text(message).multilineTextAlignment(.center)
                    if let wallImage { Image(uiImage: wallImage).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 18)) }
                    Button("Сфотографировать стену") { showCamera = true }.buttonStyle(.bordered)
                    Button(isSending ? "Отправляем..." : "Отправить в CRM") { Task { await send() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(isSending)
                }
                .padding(24)
            }

            if capturedRoom == nil {
                VStack(spacing: 10) {
                    Text(request.roomName).font(.headline)
                    Text(message).font(.footnote).multilineTextAlignment(.center)
                    Button("Контур стены готов") { controller.stop() }
                        .buttonStyle(.borderedProminent)
                }
                .padding(18)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
                .padding()
            }
        }
        .sheet(isPresented: $showCamera) {
            CameraPicker(image: $wallImage)
        }
        .navigationTitle("LiDAR-замер")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() async {
        guard let capturedRoom else { return }
        isSending = true
        do {
            let fixtures: [ScannedElement]
            if let wallImage {
                fixtures = try await FixtureDetector.detect(in: wallImage)
            } else {
                fixtures = []
            }
            let warnings = fixtures.filter { $0.confidence < 0.8 }.isEmpty
                ? []
                : ["Часть объектов распознана неуверенно и отмечена для проверки в CRM."]
            let result = ScanResult(wall: RoomPlanConverter.wall(from: capturedRoom), elements: fixtures, warnings: warnings)
            try await ScanUploader.upload(result, request: request)
            message = "Готово. Вернитесь в CRM — схема появится автоматически."
        } catch {
            message = "Не удалось отправить результат: \(error.localizedDescription)"
        }
        isSending = false
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraDevice = .rear
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraPicker
        init(parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
