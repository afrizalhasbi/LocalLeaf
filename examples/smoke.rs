//! Compiles a project and exercises SyncTeX in both directions.
//! Usage: cargo run --example smoke -- <project_dir> <main.tex> [engine]

use texcraft_core::{compiler, project::Project, synctex};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let root = args.next().expect("project dir");
    let main = args.next().unwrap_or_else(|| "main.tex".into());
    let engine: compiler::TeXEngine = args.next().as_deref().unwrap_or("pdflatex").parse()?;

    let project = Project::open(&root)?;
    let opts = compiler::CompileOptions { synctex: true, ..Default::default() };
    let result = compiler::compile_with(engine, project.resolve(&main)?, project.resolve("build")?, &opts).await?;
    println!(
        "success={} pdf={:?} synctex={:?} {}ms",
        result.success, result.pdf_path, result.synctex_path, result.duration_ms
    );
    println!("errors={:#?}\nwarnings={:#?}", result.errors, result.warnings);

    if let Some(pdf) = &result.pdf_path {
        let boxes = synctex::forward(pdf, &project.resolve(&main)?, 3, 1).await?;
        println!("forward {main}:3 -> {boxes:?}");
        if let Some(b) = boxes.first() {
            let back = synctex::inverse(pdf, b.page, b.h + 5.0, b.v - 2.0).await?;
            println!("inverse -> {back:?}");
        }
    }
    Ok(())
}
