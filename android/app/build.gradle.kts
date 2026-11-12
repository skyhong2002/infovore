plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tw.skyhong.infovore.health"
    compileSdk = 36

    defaultConfig {
        applicationId = "tw.skyhong.infovore.health"
        minSdk = 34
        targetSdk = 36
        versionCode = 16
        versionName = "0.4.3"

        // The one private host plain HTTP may reach (see android/README.md, "Private HTTP host").
        // It must match the <domain> in res/xml/network_security_config.xml; a unit test checks it.
        val tailscaleHttpHost = providers.gradleProperty("infovore.tailscaleHttpHost").getOrElse("100.85.214.25")
        require(Regex("[0-9A-Za-z.:-]+").matches(tailscaleHttpHost)) { "infovore.tailscaleHttpHost must be a bare host name or IP address" }
        buildConfigField("String", "TAILSCALE_HTTP_HOST", "\"$tailscaleHttpHost\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    testImplementation("junit:junit:4.13.2")
    // FakeHealthConnectClient. 1.0.0-alpha03 is the newest release built against connect-client 1.1.x
    // (alpha04 pulls connect-client 1.2.0-alpha05 into the test classpath), so lint's update hint is suppressed.
    //noinspection GradleDependency
    testImplementation("androidx.health.connect:connect-testing:1.0.0-alpha03")
    // The real org.json, so HealthRecordJson runs in JVM tests (android.jar only has stubs).
    testImplementation("org.json:json:20251224")
}
