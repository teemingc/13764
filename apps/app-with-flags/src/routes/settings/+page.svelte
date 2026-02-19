<script>
  let { data } = $props();
</script>

<h1>Settings</h1>
<p>Environment: {data.currentEnv}</p>
<p>Flags configured: {data.flagsConfigured}</p>
