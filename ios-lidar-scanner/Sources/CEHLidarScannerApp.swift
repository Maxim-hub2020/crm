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
    @StateObject private var visitAlerts = VisitProximityManager.shared

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("CEH CRM").font(.subheadline.bold())
                Spacer()
                Menu {
                    Text("Версия \(CRMWebView.versionLabel)")
                    Button("Вернуться в CRM / обновить экран", systemImage: "arrow.clockwise") { reloadID += 1 }
                    Button(visitAlerts.isEnabled ? "Выключить уведомления у объектов" : "Уведомлять рядом с объектом",
                           systemImage: visitAlerts.isEnabled ? "location.slash" : "location") {
                        visitAlerts.setEnabled(!visitAlerts.isEnabled)
                    }
                    if visitAlerts.isEnabled {
                        Button("Проверить разрешения геолокации", systemImage: "gearshape") {
                            if let settings = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(settings)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Меню приложения")
            }
            .padding(.horizontal, 16)
            .background(Color(uiColor: .systemBackground))
            CRMWebView(reloadID: reloadID, visitProjectID: visitAlerts.pendingProjectID,
                       visitOpenSequence: visitAlerts.visitOpenSequence) { request = $0 }
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
    @State private var scanResult: ScanResult?
    @State private var detectedElements: [ScannedElement] = []
    @State private var selectedElementID: UUID?
    @State private var activeFixtureType = "socket_single"
    @State private var isSending = false
    @State private var message = "Медленно проведите камерой по стене. Наведите метку на розетку и нажмите «Отметить»."

    var body: some View {
        ZStack(alignment: .bottom) {
            if capturedRoom == nil {
                RoomPlanScanner(controller: controller) { room in
                    capturedRoom = room
                    let result = RoomPlanConverter.result(from: room, marks: controller.marks)
                    scanResult = result
                    detectedElements = result.elements
                    message = result.warnings.first ?? "Проверьте отметки на схеме стены перед отправкой."
                } onFailed: { error in
                    message = "Ошибка LiDAR: \(error.localizedDescription)"
                }
                .ignoresSafeArea()
            } else {
                ScrollView {
                    VStack(spacing: 14) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 44)).foregroundStyle(.green)
                        Text(message).multilineTextAlignment(.center)
                        if let scanResult {
                            WallFixtureReview(wall: scanResult.wall, elements: $detectedElements,
                                              selectedID: $selectedElementID)
                        }
                        Button(isSending ? "Отправляем..." : "Отправить в CRM") { Task { await send() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(isSending || scanResult == nil)
                    }
                    .padding(24)
                }
            }

            if capturedRoom == nil {
                Image(systemName: "plus.viewfinder")
                    .font(.system(size: 44, weight: .ultraLight))
                    .foregroundStyle(.white)
                    .shadow(color: .black, radius: 4)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                VStack(spacing: 10) {
                    Text(request.roomName).font(.headline)
                    Text(message).font(.footnote).multilineTextAlignment(.center)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(FixtureKind.all) { kind in
                                Button(kind.title) { activeFixtureType = kind.type }
                                    .buttonStyle(.bordered)
                                    .tint(activeFixtureType == kind.type ? .blue : .gray)
                            }
                        }
                    }
                    Button("Отметить здесь") {
                        let kind = FixtureKind.all.first(where: { $0.type == activeFixtureType })!
                        message = controller.mark(type: kind.type, label: kind.title)
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Контур стены готов") { controller.stop() }
                        .buttonStyle(.bordered)
                }
                .padding(18)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
                .padding()
            }
        }
        .navigationTitle("LiDAR-замер")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() async {
        guard let scanResult else { return }
        isSending = true
        do {
            let result = ScanResult(wall: scanResult.wall, elements: detectedElements, warnings: scanResult.warnings)
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

private struct WallFixtureReview: View {
    let wall: ScannedWall
    @Binding var elements: [ScannedElement]
    @Binding var selectedID: UUID?
    @State private var activeType = "socket_single"

    private var selectedIndex: Int? { elements.firstIndex(where: { $0.id == selectedID }) }

    var body: some View {
        VStack(spacing: 12) {
            GeometryReader { geometry in
                let wallWidth = CGFloat(wall.width_mm ?? 2000)
                let wallHeight = CGFloat(wall.height_mm ?? 2600)
                let scale = min(geometry.size.width / wallWidth, geometry.size.height / wallHeight)
                let width = wallWidth * scale
                let height = wallHeight * scale
                ZStack(alignment: .topLeading) {
                    Rectangle().fill(Color.cyan.opacity(0.12))
                        .overlay(Rectangle().stroke(Color.blue, lineWidth: 3))
                        .frame(width: width, height: height)
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .frame(width: width, height: height)
                        .gesture(SpatialTapGesture().onEnded { event in
                            let x = min(max(Double(event.location.x / width), 0.03), 0.97)
                            let y = min(max(Double(event.location.y / height), 0.03), 0.97)
                            if let index = selectedIndex {
                                let previous = elements[index]
                                elements[index] = ScannedElement(id: previous.id, type: previous.type,
                                    x: x, y: y, width: previous.width, height: previous.height,
                                    diameter: previous.diameter, confidence: previous.confidence, label: previous.label)
                            } else {
                                let kind = FixtureKind.all.first(where: { $0.type == activeType })!
                                let marker = ScannedElement(type: kind.type, x: x, y: y,
                                    confidence: 0.9, label: kind.title)
                                elements.append(marker)
                                selectedID = marker.id
                            }
                        })
                    ForEach(elements) { element in
                        Button {
                            selectedID = element.id
                        } label: {
                            Image(systemName: "mappin")
                                .font(.caption.bold()).foregroundStyle(.white)
                                .frame(width: 32, height: 32)
                                .background(selectedID == element.id ? Color.blue : Color.orange, in: Circle())
                                .overlay(Circle().stroke(.white, lineWidth: 2))
                        }
                        .accessibilityLabel(element.label)
                        .position(x: min(max(CGFloat(element.x) * width, 16), max(width - 16, 16)),
                                  y: min(max(CGFloat(element.y) * height, 16), max(height - 16, 16)))
                    }
                }
                .frame(width: width, height: height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(height: 360)
            .background(Color.black.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))

            Text("Стена: \(wall.width_mm ?? 0) × \(wall.height_mm ?? 0) мм · отметок: \(elements.count)")
                .font(.footnote.bold())
            Text("Выберите отметку и коснитесь нужного места на стене, чтобы передвинуть её. Без выбора касание добавит новую.")
                .font(.footnote).foregroundStyle(.secondary)
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
                Button("Добавить") { selectedID = nil }
                if let index = selectedIndex {
                    Button("Удалить", role: .destructive) {
                        elements.remove(at: index)
                        selectedID = nil
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
    }
}
