// ios/mixBase/Views/Settings/UpgradeView.swift
// Shows Pro and Studio subscription options with StoreKit 2 purchase flow.

import SwiftUI
import StoreKit

struct UpgradeView: View {

    @EnvironmentObject var authService: AuthService
    @StateObject private var store = StoreKitService.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color(hex: "#080808").ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    // Header
                    VStack(spacing: 6) {
                        Text("Upgrade mixBase")
                            .font(.title2)
                            .fontWeight(.bold)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        Text("Unlock AI artwork and visualizer videos.")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                    .padding(.top, 20)

                    if store.products.isEmpty {
                        ProgressView()
                            .tint(Color(hex: "#2dd4bf"))
                            .padding(40)
                    } else {
                        ForEach(store.products, id: \.id) { product in
                            PlanCard(
                                product: product,
                                currentTier: authService.subscriptionTier,
                                isPurchasing: store.isPurchasing
                            ) {
                                Task { await store.purchase(product) }
                            }
                        }
                    }

                    if let error = store.purchaseError {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // Restore purchases
                    Button("Restore Purchases") {
                        Task { await store.restorePurchases() }
                    }
                    .font(.caption)
                    .foregroundColor(.gray)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal)
            }
        }
        .navigationTitle("Upgrade")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task { await store.loadProducts() }
    }
}

// MARK: - PlanCard
private struct PlanCard: View {

    let product: Product
    let currentTier: String
    let isPurchasing: Bool
    let onPurchase: () -> Void

    private var productTier: String {
        product.id.contains("pro.monthly") ? "pro" : "studio"
    }

    private var accentColor: Color {
        productTier == "pro" ? Color(hex: "#2dd4bf") : Color(hex: "#a78bfa")
    }

    private var features: [String] {
        productTier == "pro"
        ? ["Everything in Free", "AI artwork generation (25/mo)", "Flux 2 Pro + Imagen 4", "Branded artwork output"]
        : ["Everything in Pro", "Runway visualizer videos (10/mo)", "Gen-4 Turbo, Veo 3.1, Seedance 2.0", "Canvas-ready 9:16 exports"]
    }

    private var isCurrent: Bool { currentTier == productTier }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Tier name + price
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(.headline)
                        .foregroundColor(accentColor)
                    Text(product.displayPrice + "/month")
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                }
                Spacer()
                if isCurrent {
                    Text("Active")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(accentColor.opacity(0.15))
                        .foregroundColor(accentColor)
                        .cornerRadius(20)
                }
            }

            // Feature list
            VStack(alignment: .leading, spacing: 6) {
                ForEach(features, id: \.self) { feature in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "checkmark")
                            .font(.caption)
                            .foregroundColor(accentColor)
                            .padding(.top, 2)
                        Text(feature)
                            .font(.subheadline)
                            .foregroundColor(Color(hex: "#d0d0d0"))
                    }
                }
            }

            // CTA
            if isCurrent {
                Text("You're on this plan")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(accentColor)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
                    .background(accentColor.opacity(0.1))
                    .cornerRadius(12)
            } else {
                Button(action: onPurchase) {
                    HStack {
                        if isPurchasing {
                            ProgressView().tint(Color(hex: "#080808"))
                        } else {
                            Text("Subscribe · \(product.displayPrice)/mo")
                                .fontWeight(.semibold)
                        }
                    }
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#080808"))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(isCurrent || isPurchasing ? Color.gray.opacity(0.4) : accentColor)
                    .cornerRadius(12)
                }
                .disabled(isCurrent || isPurchasing)
            }
        }
        .padding(18)
        .background(Color(hex: "#111111"))
        .cornerRadius(16)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isCurrent ? accentColor.opacity(0.5) : Color(hex: "#222222"), lineWidth: 1)
        )
    }
}
