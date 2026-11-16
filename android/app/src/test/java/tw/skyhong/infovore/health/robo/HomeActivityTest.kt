package tw.skyhong.infovore.health.robo

import android.os.Bundle
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.FakeIngestServer
import tw.skyhong.infovore.health.HomeActivity
import tw.skyhong.infovore.health.MainActivity

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class HomeActivityTest {
    @Test fun launcherOpensTheOverviewAndSettingsIsAnExplicitAction() {
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
        val activity = controller.get()
        val root = activity.window.decorView
        assertTrue(Robo.hasVisibleText(root, "活動總覽"))
        // The phone timeline and its recorder are gone (moved to PocketLog).
        for (gone in listOf("時間軸", "手機足跡", "尚未開始記錄")) assertFalse(gone, Robo.hasVisibleText(root, gone))
        Robo.button(root, "設定").performClick()
        val intent = shadowOf(activity).nextStartedActivity
        assertEquals(MainActivity::class.java.name, intent.component?.className)
        controller.pause().stop().destroy()
    }

    @Test fun aStateSavedOnTheRemovedTimelineTabOpensTheOverview() {
        val saved = Bundle().apply { putString("tab", "phone"); putString("day", "2026-11-12") }
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup(saved)
        assertTrue(Robo.hasVisibleText(controller.get().window.decorView, "活動總覽"))
        controller.pause().stop().destroy()
    }

    @Test fun browseShowsNativeContentAndFiltersWithoutAToken() {
        FakeIngestServer().use { server ->
            EndpointPolicy.testHttpHost = "127.0.0.1"
            HomeActivity.testPublicEndpoint = server.endpoint
            try {
                server.responder = { FakeIngestServer.Response(200, """{"data":[{"source":"hardcover","title":"一個人的朝聖","mediaKind":"book","occurredAt":"2026-11-12T03:00:00Z"}]}""") }
                val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
                val root = controller.get().window.decorView
                Robo.button(root, "瀏覽").performClick()
                Robo.waitFor { Robo.hasVisibleText(root, "一個人的朝聖") }
                assertTrue(Robo.hasVisibleText(root, "Hardcover · 書籍"))
                assertNull(server.requests.last().authorization)
                Robo.button(root, "閱讀").performClick()
                Robo.waitFor { server.requests.last().path.contains("kind=book") }
                assertFalse(Robo.descendants(root).any { it is android.webkit.WebView })
                controller.pause().stop().destroy()
            } finally { EndpointPolicy.testHttpHost = null; HomeActivity.testPublicEndpoint = null }
        }
    }

    @Test
    @Config(qualifiers = "w360dp-h740dp-night-xhdpi", fontScale = 1.3f)
    fun compactDarkHomeKeepsAllNavigationActionsWithLargeText() {
        val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
        val root = controller.get().window.decorView
        for (label in listOf("總覽", "瀏覽", "設定")) {
            val button = Robo.button(root, label)
            assertTrue(button.isShown)
            assertTrue(button.minimumHeight >= Robo.dp(controller.get(), 48))
        }
        assertTrue(Robo.hasVisibleText(root, "活動總覽"))
        controller.pause().stop().destroy()
    }

    @Test
    @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w411dp-h891dp-night-xxhdpi")
    fun dashboardMirrorsTheComputerDayflowPage() {
        FakeIngestServer().use { server ->
            EndpointPolicy.testHttpHost = "127.0.0.1"
            HomeActivity.testPublicEndpoint = server.endpoint
            try {
                val overview = """{"stats":{"recordedDays":2,"todayMinutes":60,"weeklyHours":1.5,"weeklyActiveHours":1.2},"extra":{"lastSyncedAt":"2026-11-12T03:30:00Z","keywordPools":{"status":"insufficient_history","all":[{"name":"口琴教學","mentions":3}],"distinctive":[]},"categories":[{"name":"Learning","color":"#6A9C78","minutes":60}],"daily":[{"day":"2026-11-12","trackedMinutes":60,"activeMinutes":60,"idleMinutes":0,"categories":[{"name":"Learning","color":"#6A9C78","minutes":60}],"keywords":[]}]}}"""
                server.responder = { FakeIngestServer.Response(200, "{\"data\":$overview}") }
                val controller = Robolectric.buildActivity(HomeActivity::class.java).setup()
                val root = controller.get().window.decorView
                Robo.waitFor { Robo.hasVisibleText(root, "口琴教學") }
                assertTrue(Robo.hasVisibleText(root, "INFOVORE MIRROR · DAYFLOW"))
                for (section in listOf("時數總覽", "近期特別常見", "所有近期關鍵字", "本週分類", "最近有紀錄的日子")) assertTrue(Robo.hasVisibleText(root, section))
                assertTrue(Robo.hasVisibleText(root, "歷史資料累積中"))
                assertTrue(server.requests.all { it.path.startsWith("/api/dayflow.json") })
                val width = Robo.dp(controller.get(), 411)
                val height = Robo.dp(controller.get(), 891)
                root.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY))
                root.layout(0, 0, width, height)
                val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                root.draw(android.graphics.Canvas(bitmap))
                java.io.File(System.getProperty("java.io.tmpdir"), "infovore-dashboard.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
                controller.pause().stop().destroy()
            } finally { EndpointPolicy.testHttpHost = null; HomeActivity.testPublicEndpoint = null }
        }
    }
}
