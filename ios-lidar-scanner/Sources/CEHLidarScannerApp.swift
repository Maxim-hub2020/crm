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
    @State private var reloadID = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("CEH CRM").font(.subheadline.bold())
                Spacer()
                Menu {
                    Text("Версия \(CRMWebView.versionLabel)")
                    Button("Вернуться в CRM / обновить экран", systemImage: "arrow.clockwise") { reloadID += 1 }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Меню приложения")
            }
            .padding(.horizontal, 16)
            .background(Color(uiColor: .systemBackground))
            CRMWebView(reloadID: reloadID) { request = $0 }
        }
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
    @State private var detectedElements: [ScannedElement] = []
    @State private var confirmedIDs: Set<UUID> = []
    @State private var selectedElementID: UUID?
    @State private var isSending = false
    @State private var message = "Медленно проведите камерой по всей стене."
    @State private var showCamera = false

    var body: some View {
        ZStack(alignment: .bottom) {
            if capturedRoom == nil {
                RoomPlanScanner(controller: controller) { room in
                    capturedRoom = room
                    message = "Контур готов. Сфотографируйте стену и отметьте розетки, вырезы и выводы проводов."
                    showCamera = true
                } onFailed: { error in
                    message = "Ошибка LiDAR: \(error.localizedDescription)"
                }
                .ignoresSafeArea()
            } else {
                ScrollView {
                    VStack(spacing: 14) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
                    Text(message).multilineTextAlignment(.center)
                    if let wallImage {
                        PhotoFixtureReview(image: wallImage, elements: $detectedElements,
                                           confirmedIDs: $confirmedIDs, selectedID: $selectedElementID)
                        Text("Найденные прямоугольники требуют проверки. Коснитесь маркера и укажите тип; касанием фото добавьте пропущенный объект.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Сфотографировать стену") { showCamera = true }.buttonStyle(.bordered)
                    Button(isSending ? "Отправляем..." : "Отправить в CRM") { Task { await send() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(isSending)
                    }
                    .padding(24)
                }
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
        .onChange(of: showCamera) { _, isShowing in
            guard !isShowing, let wallImage else { return }
            Task {
                do {
                    detectedElements = try await FixtureDetector.detect(in: wallImage)
                    confirmedIDs = []
                    selectedElementID = nil
                    message = "Отметьте элементы на фото и проверьте их положение перед отправкой."
                } catch {
                    detectedElements = []
                    message = "Автопоиск не удался. Отметьте элементы на фото вручную: \(error.localizedDescription)"
                }
            }
        }
        .navigationTitle("LiDAR-замер")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() async {
        guard let capturedRoom else { return }
        isSending = true
        do {
            let fixtures = detectedElements.filter { confirmedIDs.contains($0.id) }
            let warnings = wallImage == nil
                ? ["Фото стены не приложено; розетки, вырезы и выводы проводов не проверены."]
                : fixtures.isEmpty ? ["На фото не подтверждены розетки, вырезы или выводы проводов."] : []
            let result = ScanResult(wall: RoomPlanConverter.wall(from: capturedRoom), elements: fixtures, warnings: warnings)
            try await ScanUploader.upload(result, request: request)
            message = "Готово. Вернитесь в CRM — схема появится автоматически."
        } catch {
            message = "Не удалось отправить результат: \(error.localizedDescription)"
        }
        isSending = false
    }
}

private struct FixtureKind: Identifiable {
    let type: String
    let title: String
    let symbol: String
    var id: String { type }

    static let all: [FixtureKind] = [
        .init(type: "socket_single", title: "Розетка", symbol: "poweroutlet.type.f"),
        .init(type: "socket_double", title: "2 розетки", symbol: "poweroutlet.type.f"),
        .init(type: "socket_triple", title: "3 розетки", symbol: "poweroutlet.type.f"),
        .init(type: "cut_circle", title: "Круглый вырез", symbol: "circle.dashed"),
        .init(type: "cut_rect", title: "Прямой вырез", symbol: "square.dashed"),
        .init(type: "power", title: "Вывод проводов", symbol: "bolt.circle"),
    ]
}

private struct PhotoFixtureReview: View {
    let image: UIImage
    @Binding var elements: [ScannedElement]
    @Binding var confirmedIDs: Set<UUID>
    @Binding var selectedID: UUID?
    @State private var activeType = "socket_single"
    @State private var movingSelected = false

    private var selectedIndex: Int? { elements.firstIndex(where: { $0.id == selectedID }) }

    var body: some View {
        VStack(spacing: 12) {
            GeometryReader { geometry in
                let scale = min(geometry.size.width / max(image.size.width, 1), geometry.size.height / max(image.size.height, 1))
                let width = image.size.width * scale
                let height = image.size.height * scale
                ZStack(alignment: .topLeading) {
                    Image(uiImage: image).resizable().frame(width: width, height: height)
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .frame(width: width, height: height)
                        .gesture(SpatialTapGesture().onEnded { event in
                            let x = min(max(Double(event.location.x / width), 0), 1)
                            let y = min(max(Double(event.location.y / height), 0), 1)
                            if movingSelected, let index = selectedIndex {
                                let previous = elements[index]
                                elements[index] = ScannedElement(id: previous.id, type: previous.type,
                                    x: x, y: y, width: previous.width, height: previous.height,
                                    diameter: previous.diameter, confidence: previous.confidence, label: previous.label)
                                movingSelected = false
                            } else {
                                let kind = FixtureKind.all.first(where: { $0.type == activeType })!
                                let marker = ScannedElement(type: kind.type, x: x, y: y,
                                    confidence: 0.9, label: kind.title)
                                elements.append(marker)
                                confirmedIDs.insert(marker.id)
                                selectedID = marker.id
                            }
                        })
                    ForEach(elements) { element in
                        Button {
                            selectedID = element.id
                            movingSelected = false
                        } label: {
                            Image(systemName: confirmedIDs.contains(element.id) ? "checkmark" : "questionmark")
                                .font(.caption.bold()).foregroundStyle(.white)
                                .frame(width: 32, height: 32)
                                .background(selectedID == element.id ? Color.blue : confirmedIDs.contains(element.id) ? Color.green : Color.orange, in: Circle())
                                .overlay(Circle().stroke(.white, lineWidth: 2))
                        }
                        .accessibilityLabel(element.label)
                        .position(x: CGFloat(element.x) * width, y: CGFloat(element.y) * height)
                    }
                }
                .frame(width: width, height: height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(height: 360)
            .background(Color.black.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))

            Text("Подтверждено: \(confirmedIDs.count) · требует проверки: \(elements.count - confirmedIDs.count)")
                .font(.footnote.bold())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(FixtureKind.all) { kind in
                        Button(kind.title) { select(kind) }
                            .buttonStyle(.bordered)
                            .tint(activeType == kind.type ? .blue : .gray)
                    }
                }
            }
            HStack {
                Button("Добавить на фото") { selectedID = nil; movingSelected = false }
                if let index = selectedIndex {
                    Button(movingSelected ? "Коснитесь нового места" : "Переместить") { movingSelected = true }
                    Button("Удалить", role: .destructive) {
                        confirmedIDs.remove(elements[index].id)
                        elements.remove(at: index)
                        selectedID = nil
                        movingSelected = false
                    }
                }
            }
            .font(.footnote)
            .buttonStyle(.bordered)
        }
    }

    private func select(_ kind: FixtureKind) {
        activeType = kind.type
        guard let index = selectedIndex else { return }
        let old = elements[index]
        elements[index] = ScannedElement(id: old.id, type: kind.type, x: old.x, y: old.y,
            width: old.width, height: old.height, diameter: old.diameter,
            confidence: 0.9, label: kind.title)
        confirmedIDs.insert(old.id)
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
            if let photo = info[.originalImage] as? UIImage {
                let renderer = UIGraphicsImageRenderer(size: photo.size)
                parent.image = renderer.image { _ in photo.draw(in: CGRect(origin: .zero, size: photo.size)) }
            }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
